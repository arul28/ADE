import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import { syncDeviceTelemetryRef } from "../analytics/machineTelemetryId";
import fs from "node:fs";
import { addSentryBreadcrumb, captureError } from "../../../shared/sentry/capture";
import { AdeExpectedError } from "../../../shared/expectedError";
import type {
  AdeActionRegistryEntry,
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  ProjectIcon,
  RemoteRuntimeProjectIconUpload,
  RemoteRuntimeProjectWorkSummary,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionRecovery,
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
import type { ChatAttachmentStagingMode } from "../../../shared/types/chat";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_BYTES,
  approxDecodedBytes,
  attachmentTooLargeMessage,
  maxBase64EncodedLength,
} from "../../../shared/chatAttachmentLimits";
import {
  capRemoteRuntimeErrorDetail,
  REMOTE_RUNTIME_EXPLICIT_CONNECT_ONLY_MESSAGE,
  REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE,
  REMOTE_TARGET_NOT_FOUND_MESSAGE,
  RemoteRuntimeConnectError,
} from "../../../shared/types";
import { coerceProjectIcon, coerceProjects } from "./remoteBootstrap";
import type {
  ProjectRemovalOutcome,
  ProjectRemovalReport,
  ProjectRemovalRequest,
  RemoteProjectRemovalInspection,
} from "../../../shared/projectRemoval";

/** A permanent delete of a large folder runs in a separate process with retries; it can take minutes. */
const PROJECT_REMOVAL_TIMEOUT_MS = 10 * 60_000;
import {
  parseRemoteAttachmentUploadTicket,
  uploadRemoteAttachment,
  withTempAttachmentFile,
} from "./attachmentUploadClient";
import {
  isRemoteRuntimeConnectionError,
  type RemoteConnectionPool,
} from "./remoteConnectionPool";
import type { Logger } from "../logging/logger";
import { RemoteDialTelemetry, type RemoteDialOutcome } from "./remoteDialTelemetry";
import {
  REMOTE_RUNTIME_EVENT_SETUP_SLOW_MS,
  runWithEventSetupDeadline,
  type RemoteEventSetupPhase,
} from "./remoteEventSetup";
import { HostReturnWatches } from "./remoteHostReturnWatch";
import { CloudAsleepChecks } from "./remoteCloudAsleepChecks";
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
  isPairedRuntimeRpcOverBudgetError,
  isPairedRuntimeSupersededError,
  PairedRuntimeRelayAuthRequiredError,
  PairedRuntimeSshTrustRequiredError,
  PairedRuntimeTransportUnavailableError,
  REMOTE_CONNECT_STOPPED_NOTICE,
  RemoteActionOutcomeUnknownError,
  RemoteConnectBackoffError,
  type PairedRuntimeRouteDiagnostic,
} from "./pairedRuntimeErrors";
import {
  getSshHostKeyTrustForTarget,
  trustSshHostKeyForTarget,
} from "./sshTransport";
import { decodeRemoteRuntimeHandoffStoragePreflightResult } from "../../../shared/crossMachineHandoff";
import {
  describeHostWentAway,
  describeLinkHeldByOtherAdeApp,
  type HostWentAwayRecovery,
} from "../../../shared/connectionDiagnosis";
import { adeActionAccess, isBackgroundAdeWrite, isReplaySafeAdeAction } from "../../../shared/adeActionAccess";
import { isRuntimeTransportTimeoutError } from "../../../shared/runtimeErrors";
import { findMachineProject } from "../../../shared/projectIdentity";
import { isMachineScopeUnknownProjectError, MACHINE_SCOPE_PROJECT_ID, machineScopeUpdateMessage } from "../../../shared/machineScope";
// How long a woken machine gets to come back online before the call fails as usual.
import { WOKEN_MACHINE_CONNECT_WAIT_MS } from "../../../shared/wokenMachine";

type StatusPatch = Partial<Omit<RemoteRuntimeConnectionStatus, "target">>;

type RemoteConnectionServiceOptions = {
  /** Receives one line per outage saying which routes were tried and how each ended. */
  logger?: Pick<Logger, "info">;
  onDialOutcome?: (outcome: RemoteDialOutcome) => void;
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
  /**
   * Open a connection only when the person presses Connect in this app. A
   * remote host keeps one connection per paired device, and every ADE on this
   * computer shares the device pairing in ~/.ade, so a dev desktop that
   * reconnected saved machines on its own took them from the installed ADE,
   * which then (rightly) waits for the person instead of fighting back.
   */
  explicitConnectOnly?: boolean;
  /**
   * Wakes a sleeping cloud machine (a cloud box) the person is about to
   * use. True when it woke one, so the connect waits for it to come back;
   * throws with the reason when it may not (the monthly cap). Asked only for
   * an explicit Connect and for a call that changes something: background
   * reads never wake a box, or an open window would keep it awake forever.
   */
  wakeForUse?: (target: RemoteRuntimeTarget) => Promise<boolean>;
  /**
   * Whether a cloud computer is asleep or stopped. Asked when a call to it
   * fails the way a sleeping computer fails (its relay tunnel looks open until
   * a call times out), so the app shows it as not connected, quietly, where it
   * used to show a connected machine whose reads fail. Null for a machine that
   * isn't a cloud computer: at once when that is plain, or as the answer after
   * a bounded lookup. Such a machine then takes the normal failure path.
   */
  asleepForUse?: (target: RemoteRuntimeTarget) => Promise<boolean | null> | null;
  /**
   * A cloud computer started or ended a rest (found asleep, or answering
   * again). Once per change. The owner tells the windows, whose view of the
   * computer is otherwise read only when a wake or a cloud action changes it.
   */
  onCloudRestChanged?: (targetId: string, resting: boolean) => void;
};

const WOKEN_MACHINE_RETRY_MS = 1_500;
/**
 * How often a cloud computer found asleep is asked about again, so one that
 * something else woke (a timer, the phone) reconnects by itself. No dial goes
 * out in between; a person's use wakes it at once.
 */
const CLOUD_ASLEEP_RECHECK_MS = 5 * 60_000;
/** After a link dropped and the computer still read as awake: when to ask again. */
const CLOUD_ASLEEP_FOLLOW_UP_MS = [45_000, 90_000];

const EXPLICIT_CONNECT_ONLY_MESSAGE = REMOTE_RUNTIME_EXPLICIT_CONNECT_ONLY_MESSAGE;

export type AccountMachineReconciliationResult = {
  removedTargetIds: string[];
  removedCredentialHostIds: string[];
  /**
   * Detail for the removed pairings. Dropping a paired secret forces the user
   * to re-pair that machine by hand, so the reason has to be reconstructable
   * afterwards from a log — counts alone are not enough to tell an intended
   * account switch from an identity glitch that silently cost trust.
   */
  removedCredentials: Array<{
    hostDeviceId: string;
    hostName: string | null;
    previousOwnerUserId: string | null;
  }>;
  currentOwnerUserId: string | null;
};

type RemoteConnectionDisconnectOptions = {
  manual?: boolean;
};

type RemoteConnectionConnectOptions = {
  explicit?: boolean;
  /**
   * With `explicit`: a window asked for the machine, but no person did (a
   * project tab joining every computer with a copy). It neither wakes a
   * sleeping cloud computer nor starts the machine's brain.
   */
  background?: boolean;
};

// A machine that restarts for an update is back in one to two minutes; a
// 30 s base doubling to 5 min left it showing as offline for several minutes
// after it was up. One dial every 2 min to a machine that stays off costs little.
const AUTOMATIC_RECONNECT_BASE_BACKOFF_MS = 10_000;
const AUTOMATIC_RECONNECT_MAX_BACKOFF_MS = 2 * 60_000;
/** Failed reconnects in a row (about 70 s of them) before one Sentry signal. */
const RECONNECT_FAILURES_BEFORE_SIGNAL = 4;
const MAX_LAST_ERROR_CHARS = 500;
/**
 * A link this app had open dropped because the machine went away. A brain
 * restart is back in 5 to 30 s, so the first redial comes almost at once and
 * the rest follow the automatic-reconnect backoff above. After this long the
 * app stops and waits for the person, so a dev app never keeps dialing a
 * machine that is off for good.
 */
const HOST_RETURN_FIRST_ATTEMPT_MS = 1_000;
const HOST_RETURN_WATCH_MS = 10 * 60_000;
const DISCOVERED_ENDPOINT_REFRESH_INTERVAL_MS = 60_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capLastError(message: string): string {
  if (message.length <= MAX_LAST_ERROR_CHARS) return message;
  return `${message.slice(0, MAX_LAST_ERROR_CHARS - 1)}…`;
}

/**
 * Route diagnostics travel with the error, not inside the message. `failure`
 * is what the headline was written from, and it is what the UI keys recovery
 * actions off — the message text is never parsed.
 */
function diagnosticFields(
  diagnostic: PairedRuntimeRouteDiagnostic,
): Pick<
  RemoteRuntimeConnectErrorInfo,
  "correlationId" | "attempts" | "omittedAttemptCount" | "failure"
> {
  return {
    correlationId: diagnostic.correlationId,
    attempts: diagnostic.attempts,
    ...(diagnostic.omittedAttemptCount != null
      ? { omittedAttemptCount: diagnostic.omittedAttemptCount }
      : {}),
    ...(diagnostic.failure ? { failure: diagnostic.failure } : {}),
  };
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
      ...(error.diagnostic ? diagnosticFields(error.diagnostic) : {}),
    };
  }
  if (
    error instanceof PairedRuntimeTransportUnavailableError
    && error.diagnostic
  ) {
    return {
      kind: "generic",
      message,
      ...diagnosticFields(error.diagnostic),
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

export function automaticReconnectBackoffMs(failureCount: number): number {
  const normalizedCount = Math.max(1, Math.floor(failureCount));
  return Math.min(
    AUTOMATIC_RECONNECT_MAX_BACKOFF_MS,
    AUTOMATIC_RECONNECT_BASE_BACKOFF_MS * 2 ** Math.min(normalizedCount - 1, 10),
  );
}

function isImplicitConnectionFailure(error: unknown): boolean {
  // One oversized reply closed one RPC channel. The host answered, so the
  // machine is reachable; the next call opens a new channel.
  if (isPairedRuntimeRpcOverBudgetError(error)) return false;
  // Another client took the connection. The machine answered; nothing here is
  // a failure to back off from.
  if (isPairedRuntimeSupersededError(error)) return false;
  // The call's answer was lost, but the machine answered again right after,
  // or another call that dropped the connection already reports on it.
  if (error instanceof RemoteActionOutcomeUnknownError && error.reconnected !== false) return false;
  // Connect failures carry a structured kind; their text names the cause
  // ("SSH authentication failed", "Nothing is accepting SSH connections"), not
  // the connection, so the pattern below does not see them.
  if (error instanceof RemoteRuntimeConnectError) return true;
  if (error instanceof PairedRuntimeTransportUnavailableError) return true;
  if (isRemoteRuntimeConnectionError(error)) return true;
  const message = errorMessage(error);
  return /remote (?:runtime|ADE service) connection was interrupted|sync (?:connection|websocket|endpoint).*(?:closed|failed)|remote target is not connected|SSH server at .* closed the connection before ADE could finish the SSH handshake|Timed out while waiting for the SSH handshake/i.test(
    message,
  );
}

function isConnectionBackoffThrottle(error: unknown): boolean {
  return error instanceof RemoteConnectBackoffError;
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

function sameStatusValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * After a wake, may this call go out again? Replay-safe actions may. A chat send
 * may when it carries a client id and the brain says it recognizes a retry of one
 * it already took, so a message caught by a sleep is delivered, and never twice.
 */
function isRetriableAfterSleep(request: RemoteRuntimeActionRequest, brainDedupesSends: boolean): boolean {
  if (isReplaySafeAdeAction(request.domain, request.action)) return true;
  if (!brainDedupesSends || request.domain !== "chat" || request.action !== "sendMessage") return false;
  const args = request.args as { clientSendId?: unknown } | undefined;
  return typeof args?.clientSendId === "string" && args.clientSendId.length > 0;
}

export class RemoteConnectionService {
  private readonly statusById = new Map<string, StatusPatch>();
  private readonly manuallyDisconnectedTargetIds = new Set<string>();
  /** With `explicitConnectOnly`: machines the person connected in this app. */
  private readonly explicitlyConnectedTargetIds = new Set<string>();
  private readonly automaticReconnectFailuresByTargetId = new Map<
    string,
    number
  >();
  private readonly automaticReconnectRetryAtByTargetId = new Map<string, number>();
  /** Which cloud computers are asleep, and the questions that find out. */
  private readonly asleepChecks = new CloudAsleepChecks(
    {
      ask: (target) => this.options.asleepForUse?.(target) ?? null,
      stillWanted: (target) => Boolean(this.registry.get(target.id)) && !this.isManuallyDisconnected(target),
      linkIsDown: (targetId) => this.statusById.get(targetId)?.state === "error",
      rest: (target) => this.restAsleep(target),
      restChanged: (targetId, resting) => this.options.onCloudRestChanged?.(targetId, resting),
    },
    CLOUD_ASLEEP_FOLLOW_UP_MS,
  );
  private readonly disconnectGenerationByTargetId = new Map<string, number>();
  private readonly latencyProbeTargetIds = new Set<string>();
  /** Redials for each dropped link, until the machine is back or the time is up. */
  private readonly hostReturnWatches = new HostReturnWatches(
    {
      // Implicit, so it keeps every guard a call has: a dev app's
      // connected-in-this-run rule, a manual disconnect, the dial backoff.
      attempt: async (targetId) => {
        await this.connect(targetId);
      },
      onAttemptFailed: (targetId, error, attempts) => this.hostReturnAttemptFailed(targetId, error, attempts),
      onExpired: (targetId) => this.hostReturnWatchExpired(targetId),
    },
    { firstAttemptMs: HOST_RETURN_FIRST_ATTEMPT_MS, watchMs: HOST_RETURN_WATCH_MS },
  );
  private readonly dialTelemetry: RemoteDialTelemetry;
  private readonly pairedFallbackSshTrustByTargetId = new Map<
    string,
    Extract<RemoteRuntimeSshHostKeyTrustStatus, { state: "needs_trust" | "changed" }>
  >();
  private readonly listeners = new Set<
    (snapshot: RemoteRuntimeConnectionSnapshot) => void
  >();
  private autoconnectTimer: NodeJS.Timeout | null = null;
  /** Strictly increasing, so a window can always tell the newer of two snapshots. */
  private lastSnapshotAt = 0;
  /** Machine and id pairs already logged by `noteUnroutedProjectId`. */
  private readonly unroutedProjectIdsLogged = new Set<string>();
  private readonly inFlightStreamEvents = new Map<
    string,
    Promise<RemoteRuntimeStreamEventsResult>
  >();

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly pool: RemoteConnectionPool,
    private readonly options: RemoteConnectionServiceOptions = {},
    private readonly pairedStore: DesktopPairedMachineStore = new DesktopPairedMachineStore(),
  ) {
    this.dialTelemetry = new RemoteDialTelemetry({
      describeTarget: (targetId) => this.describeDialTarget(targetId),
      logger: this.options.logger,
      onOutcome: this.options.onDialOutcome,
    });
    this.pool.onDialFailed((targetId, error) => this.dialTelemetry.noteFailed(targetId, error));
    // A call that finds the machine gone reconnects on its own, without
    // `connect()`. The machine may have restarted on a new version (an update
    // it was just sent), so what it reports now replaces what it reported at
    // the last explicit Connect. Without this the list kept the old version
    // and called a finished update "didn't apply".
    this.pool.onEntryConnected((targetId, result) => {
      this.dialTelemetry.noteConnected(targetId, result.route);
      // The machine is back, whoever dialed it.
      this.hostReturnWatches.stop(targetId);
      // A connect that finishes after the machine was removed or disconnected
      // by hand must not write it back.
      if (!this.registry.get(targetId) || this.manuallyDisconnectedTargetIds.has(targetId)) return;
      this.mergeStatus(targetId, {
        version: result.version,
        // Read with the version, so a brain that stopped reporting it clears it.
        appVersion: result.appVersion ?? null,
        updateInstallMode: result.updateInstallMode,
        downloadUrl: result.downloadUrl ?? null,
        arch: result.arch,
        ...(result.route ? { route: result.route } : {}),
        ...(result.capabilities ? { capabilities: result.capabilities } : {}),
        // Warnings come from the version too ("missing capabilities … update
        // ADE on that machine"); an updated machine must not keep the old ones.
        compatibilityWarnings: result.compatibilityWarnings,
        // A clean reconnect clears an older freeze; a fresh one replaces it.
        hostStall: result.hostStall ?? null,
        hostStorageWait: result.hostStorageWait ?? null,
        connectedAt: result.target.lastConnectedAt ?? Date.now(),
      });
    });
    // A project folder there stopped (or started again) answering while the
    // connection stayed up: the machine row says so at once.
    this.pool.onHostStorageWait((targetId, wait) => {
      if (!this.registry.get(targetId)) return;
      this.mergeStatus(targetId, { hostStorageWait: wait });
    });
    this.pool.onEntryEvicted((targetId, error) => {
      const current = this.statusById.get(targetId);
      if (current?.state !== "connected" && current?.state !== "connecting") {
        return;
      }
      // The host answered and refused one reply as too large. The next call
      // opens a new channel, so the machine is still reachable.
      if (isPairedRuntimeRpcOverBudgetError(error)) return;
      if (isPairedRuntimeSupersededError(error)) {
        this.explicitlyConnectedTargetIds.delete(targetId);
        // Another client with this computer's pairing took the connection.
        // Reconnecting would close it in turn, and the two would trade the
        // machine every few seconds. Held in memory only: nothing is written
        // to the saved machine, and Connect takes the connection back.
        this.manuallyDisconnectedTargetIds.add(targetId);
        this.hostReturnWatches.stop(targetId);
        this.mergeStatus(targetId, {
          state: "error",
          ...errorStatusPatch(
            error,
            describeLinkHeldByOtherAdeApp(this.registry.get(targetId)?.name),
          ),
          lastAttemptedAt: Date.now(),
          recovery: "held_elsewhere",
        });
        return;
      }
      const target = this.registry.get(targetId);
      if (!target || !isImplicitConnectionFailure(error)) {
        this.mergeStatus(targetId, {
          state: "error",
          ...errorStatusPatch(error),
          lastAttemptedAt: Date.now(),
        });
        return;
      }
      // ADE on that machine went away: it restarted, quit, or its network
      // dropped (relay "host unavailable", the host's socket closed). The
      // link was open in this app, so bring it back when the machine is back,
      // unless the person turned that off. A dev app does it only for a
      // machine it was told to connect in this run (see `explicitConnectOnly`).
      const { recovery } = this.beginRecoveryAfterDrop(target);
      this.mergeStatus(targetId, {
        state: "error",
        ...errorStatusPatch(error, describeHostWentAway(target.name, recovery)),
        lastAttemptedAt: Date.now(),
        recovery,
      });
      // A cloud computer that went to sleep closes its link the same way; it
      // then rests instead of showing an error and redialing.
      void this.asleepAfterFailure(targetId, error);
    });
  }

  listTargets(): RemoteRuntimeTarget[] {
    return this.registry.list();
  }

  getTarget(targetId: string): RemoteRuntimeTarget | null {
    return this.registry.get(targetId);
  }

  /**
   * Whether this target is connected *right now*.
   *
   * For opportunistic background readers that must not trigger an implicit
   * reconnect: a failed call on a disconnected target spends that machine's
   * automatic-reconnect backoff, and a failed target is retried with bounded
   * exponential spacing rather than being latched off permanently.
   */
  isConnected(targetId: string): boolean {
    return this.statusById.get(targetId)?.state === "connected";
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
      this.explicitlyConnectedTargetIds.delete(targetId);
      this.clearAutomaticReconnectState(targetId);
      this.pool.clearConnectFailure(targetId);
      this.latencyProbeTargetIds.delete(targetId);
      this.pairedFallbackSshTrustByTargetId.delete(targetId);
    }
    for (const targetId of disconnectedRelayTargetIds) {
      if (removedTargetIds.has(targetId)) continue;
      const target = this.registry.get(targetId);
      if (!target) continue;
      this.bumpDisconnectGeneration(targetId);
      this.mergeStatus(targetId, { state: "idle", lastError: null });
      this.clearAutomaticReconnectState(targetId);
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
      removedCredentials: removedCredentials.map((credentials) => ({
        hostDeviceId: credentials.hostIdentity.deviceId,
        hostName: credentials.hostIdentity.name ?? null,
        previousOwnerUserId: credentials.accountOwnerUserId ?? null,
      })),
      currentOwnerUserId,
    };
  }

  async reconcileAuthorizedAccountOwnership(): Promise<AccountMachineReconciliationResult> {
    if (!this.options.getAuthorizedAccountOwnerId) {
      return {
        removedTargetIds: [],
        removedCredentialHostIds: [],
        removedCredentials: [],
        currentOwnerUserId: null,
      };
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
      this.clearAutomaticReconnectState(target.id);
      // A stopped SSH machine's message was cleared by its disconnect. Let the
      // next automatic attempt dial once, so the row says again why it stops.
      this.pool.clearConnectFailure(target.id);
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
    // An edit (a new user, key or port) may fix what failed, so the next call
    // or automatic reconnect tries again instead of waiting out the backoff.
    this.pool.clearConnectFailure(target.id);
    this.clearAutomaticReconnectState(target.id);
    this.mergeStatus(target.id, { state: "idle", lastError: null });
    return target;
  }

  /**
   * `observedAt` is when the browse started, not when it finished: a dial that
   * failed during the browse must not be cleared by a sighting that may predate it.
   */
  rememberDiscoveredMachines(
    machines: RemoteRuntimeDiscoveredMachine[],
    observedAt = Date.now(),
  ): void {
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
        // Inside the window a sighting is skipped only if it already comes after
        // the route's last failure. Otherwise it is the one thing that clears
        // the demotion, and skipping it would keep the route demoted for a minute.
        return state?.lastDiscoveredAt != null
          && observedAt - state.lastDiscoveredAt
            < DISCOVERED_ENDPOINT_REFRESH_INTERVAL_MS
          && state.lastDiscoveredAt > (state.lastFailedAt ?? 0);
      });
      if (discoveryIsFresh) continue;
      this.pairedStore.markEndpointsDiscovered(
        paired.hostIdentity.deviceId,
        endpoints,
        observedAt,
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
            // Known from the pairing payload; lets the store reuse this
            // desktop's existing identity for the host instead of orphaning
            // a record there on every re-pair.
            hostDeviceId: parsed.hostIdentity.deviceId,
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
    const liveConnection = this.liveConnectionForDoctor(savedTarget, credentials);
    return await runRemoteRuntimeDoctor({
      target,
      credentials,
      machineName: target?.name ?? discoveredMachine?.machineName ?? credentials?.hostIdentity?.name ?? null,
      // A host takes a login from this device as a newer connection and
      // closes the open one, which then reads as "another ADE is using the
      // connection" and stays down. So while this app has one open or
      // opening, routes are only opened, unless its host said it answers
      // probes without that. The open connection already proves the pairing.
      routeProbe: liveConnection && !liveConnection.hostAcceptsProbes ? "reachability" : "login",
      getAccountRelayProof: this.options.getAccountRelayProof,
    });
  }

  /**
   * This app's connection to the machine under test, open or opening. A test
   * started from a discovered row names no saved target, and two saved
   * targets can share one pairing, so any target on the same host counts.
   */
  private liveConnectionForDoctor(
    savedTarget: RemoteRuntimeTarget | null,
    credentials: DesktopPairedMachineCredentials | null,
  ): { hostAcceptsProbes: boolean } | null {
    const hostIdentity = credentials?.hostIdentity?.deviceId ?? null;
    const candidates = [
      ...(savedTarget ? [savedTarget.id] : []),
      ...(hostIdentity
        ? this.registry.list()
          .filter((entry) => entry.pairedMachine?.hostIdentity === hostIdentity)
          .map((entry) => entry.id)
        : []),
    ];
    for (const targetId of candidates) {
      const state = this.pool.liveConnectionState(targetId);
      if (state) return state;
    }
    return null;
  }

  removeTarget(targetId: string): boolean {
    const target = this.registry.get(targetId);
    const pairedCredentials = target?.transport === "paired" && target.pairedMachine
      ? this.pairedStore.getForReference(target.pairedMachine)
      : null;
    this.disconnect(targetId);
    this.manuallyDisconnectedTargetIds.delete(targetId);
    this.clearAutomaticReconnectState(targetId);
    this.pool.clearConnectFailure(targetId);
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
    this.pool.clearConnectFailure(targetId);
    this.clearAutomaticReconnectState(targetId);
    this.emit();
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
          // Only beside the live version it was read with, never beside the
          // persisted one, which can be from another connection.
          appVersion: status.version != null ? status.appVersion ?? null : null,
          updateInstallMode: status.version != null ? status.updateInstallMode : undefined,
          downloadUrl: status.version != null ? status.downloadUrl ?? null : null,
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
          ...(status.hostStall ? { hostStall: status.hostStall } : {}),
          // Live state, so only while connected: an old wait must not linger on a dropped machine.
          ...(status.hostStorageWait && status.state === "connected" ? { hostStorageWait: status.hostStorageWait } : {}),
          reconnectBlocked: this.isManuallyDisconnected(target) ? "disconnected" : null,
          ...(status.recovery && status.state === "error" ? { recovery: status.recovery } : {}),
        };
      });
    this.lastSnapshotAt = Math.max(Date.now(), this.lastSnapshotAt + 1);
    return {
      connections,
      connectedCount: connections.filter((entry) => entry.state === "connected")
        .length,
      updatedAt: this.lastSnapshotAt,
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
    if (this.options.explicitConnectOnly) return;
    for (const target of this.registry.list()) {
      if (!shouldAutoconnectTarget(target)) continue;
      if (this.isManuallyDisconnected(target) || this.isHeldForUserAction(target.id)) continue;
      if (!this.automaticReconnectRetryIsDue(target.id)) continue;
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

  /** Ends every redial for a dropped link at once (the app is quitting). */
  stopHostReturnWatches(): void {
    this.hostReturnWatches.stopAll();
    this.asleepChecks.stopAll();
  }

  async connect(
    targetId: string,
    options: RemoteConnectionConnectOptions = {},
  ): Promise<RemoteRuntimeConnectResult> {
    const target = this.requireTarget(targetId);
    // Taken before the first await so a cancel (disconnect or remove) that
    // lands during the ownership check still stops this attempt.
    const disconnectGeneration = this.getDisconnectGeneration(target.id);
    await this.assertAccountOwnershipAuthorized(target);
    if (!this.isDisconnectGenerationCurrent(target.id, disconnectGeneration)) {
      throw new Error(
        "Remote target was disconnected before ADE finished connecting.",
      );
    }
    this.pairedFallbackSshTrustByTargetId.delete(target.id);
    const explicit = options.explicit === true;
    const unattended = explicit && options.background === true;
    if (unattended) {
      // Nobody asked: the person's Disconnect stands, and a build that dials
      // only what the person connected here (`explicitConnectOnly`) does not
      // take a machine on its own.
      if (this.options.explicitConnectOnly && !this.explicitlyConnectedTargetIds.has(target.id)) {
        throw new Error(EXPLICIT_CONNECT_ONLY_MESSAGE);
      }
      if (this.isManuallyDisconnected(target)) throw new Error(REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE);
    } else if (explicit) {
      this.manuallyDisconnectedTargetIds.delete(target.id);
      this.clearAutomaticReconnectState(target.id);
    } else {
      this.assertImplicitReconnectAllowed(target.id);
    }
    this.mergeStatus(target.id, {
      state: "connecting",
      lastAttemptedAt: Date.now(),
      lastError: null,
    });
    try {
      // Asked even with a pool entry: a sleeping box's relay tunnel can look
      // open until a call times out. Only cloud boxes cost a lookup.
      const woke = explicit && !unattended && this.options.wakeForUse ? await this.options.wakeForUse(target) : false;
      // An explicit connect counts as the person asking for this machine
      // (Connect, Test, Try again, and opening or switching to one of its
      // projects), so it may start the machine's brain. Unattended
      // reconnects, the event pump and autoconnect dial as "background".
      const result = woke
        ? await this.connectWokenMachine(target)
        : explicit
          ? await this.pool.connect(target, { bypassFailureBackoff: true, initiatedBy: unattended ? "background" : "user" })
          : await this.pool.connect(target, { initiatedBy: "background" });
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
        appVersion: connectedResult.appVersion ?? null,
        updateInstallMode: connectedResult.updateInstallMode,
        downloadUrl: connectedResult.downloadUrl ?? null,
        route: connectedResult.route,
        capabilities: connectedResult.capabilities,
        compatibilityWarnings: connectedResult.compatibilityWarnings,
        hostStall: connectedResult.hostStall ?? null,
        hostStorageWait: connectedResult.hostStorageWait ?? null,
        projects: connectedResult.projects,
        connectedAt: connectedResult.target.lastConnectedAt ?? Date.now(),
        lastAttemptedAt: Date.now(),
        lastError: null,
      });
      this.clearAutomaticReconnectState(connectedResult.target.id);
      this.hostReturnWatches.stop(connectedResult.target.id);
      this.pairedFallbackSshTrustByTargetId.delete(connectedResult.target.id);
      if (explicit && !unattended) this.explicitlyConnectedTargetIds.add(connectedResult.target.id);
      return connectedResult;
    } catch (error) {
      if (!this.isDisconnectGenerationCurrent(target.id, disconnectGeneration)) {
        throw error;
      }
      if (error instanceof PairedRuntimeSshTrustRequiredError) {
        this.pairedFallbackSshTrustByTargetId.set(target.id, error.trustStatus);
      }
      if (isConnectionBackoffThrottle(error)) {
        // Nothing was dialed. The status keeps the failure that started the
        // wait, with its structured kind, instead of this refusal.
        const previous = this.statusById.get(target.id);
        this.mergeStatus(target.id, {
          state: "error",
          ...(previous?.lastError ? {} : errorStatusPatch(error)),
        });
        throw error;
      }
      const lastError = explicit
        ? errorMessage(error)
        : this.recordImplicitFailure(target.id, error);
      this.mergeStatus(target.id, {
        state: "error",
        ...errorStatusPatch(error, this.withRetryNotice(target.id, lastError)),
        lastAttemptedAt: Date.now(),
        recovery: this.recoveryAfterFailure(target.id),
      });
      // A redial that found a cloud computer asleep ends the redials. A
      // person's Connect woke it first, so its failure is a real one.
      if (!explicit) void this.asleepAfterFailure(target.id, error);
      throw error;
    }
  }

  disconnect(
    targetId: string,
    options: RemoteConnectionDisconnectOptions = {},
  ): void {
    let persistenceError: unknown = null;
    if (options.manual) {
      this.explicitlyConnectedTargetIds.delete(targetId);
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
    // Disconnect, Cancel and Remove all end the redials for a dropped link.
    this.hostReturnWatches.stop(targetId);
    this.pool.disconnect(targetId);
    this.mergeStatus(targetId, { state: "idle", lastError: null });
    // Windows stop calling a machine they see as disconnected. The status may
    // already have been idle, so say it even when no status field changed.
    if (options.manual) this.emit();
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
      this.clearAutomaticReconnectState(targetId);
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
      this.clearAutomaticReconnectState(targetId);
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
    // Connect only when there is no connection. `connect` reports
    // "connecting" first, and a live view asks for its forward on every
    // start, so an open machine read as not connected for a moment on each
    // start; views keyed on that state remounted and started again, forever.
    if (!this.pool.hasEntry(target.id)) await this.connect(target.id);
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

  /**
   * Store a new icon for a project on the host machine, so every device that
   * lists the host's projects sees it. Returns the icon as the host now
   * resolves it and patches the cached project list so renderers update.
   */
  async setProjectIcon(
    targetId: string,
    rootPath: string,
    upload: RemoteRuntimeProjectIconUpload,
  ): Promise<ProjectIcon | null> {
    const value = await this.callProjectIconMethod(targetId, "projects.setIcon", {
      rootPath,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      dataBase64: upload.dataBase64,
    });
    const icon = coerceProjectIcon(value);
    this.patchProjectIcon(targetId, rootPath, icon);
    return icon;
  }

  /** Clear a host project's custom icon; returns the icon the host falls back to. */
  async removeProjectIcon(
    targetId: string,
    rootPath: string,
  ): Promise<ProjectIcon | null> {
    const value = await this.callProjectIconMethod(targetId, "projects.removeIcon", { rootPath });
    const icon = coerceProjectIcon(value);
    this.patchProjectIcon(targetId, rootPath, icon);
    return icon;
  }

  /**
   * The state of a host's copy of a project, for the remove dialog. Asked
   * only of a machine that is connected now: this never dials, reconnects or
   * wakes one. A host without `projects.inspectRemoval` answers
   * `supported: false`, and the dialog offers entry-only removal there.
   */
  async inspectProjectRemoval(
    targetId: string,
    projectId: string,
  ): Promise<RemoteProjectRemovalInspection> {
    const target = this.requireConnectedTargetForRemoval(targetId);
    if (this.statusById.get(target.id)?.capabilities?.machineProjects?.removeCopy !== true) {
      return { supported: false, entryOnly: true };
    }
    const value = await this.callMachine(target, "projects.inspectRemoval", { projectId }, {
      retryOnConnectionError: false,
    });
    return { supported: true, report: value as ProjectRemovalReport };
  }

  /**
   * Removes a project from a host: its entry, and its folder when asked (the
   * host deletes it for good: it has no trash). The host checks the copy
   * again right before a delete and refuses when it changed. A host without
   * `projects.removeCopy` gets the old `projects.remove` for an entry-only
   * removal, and a clear refusal for a delete.
   */
  async removeProjectCopy(
    targetId: string,
    projectId: string,
    request: ProjectRemovalRequest,
  ): Promise<ProjectRemovalOutcome> {
    const target = this.requireConnectedTargetForRemoval(targetId);
    const machineName = target.name || target.hostname;
    const supported = this.statusById.get(target.id)?.capabilities?.machineProjects?.removeCopy === true;
    let outcome: ProjectRemovalOutcome;
    if (!supported) {
      if (request.deleteFolder) {
        return { status: "refused", code: "unsupported", reason: `Update ADE on ${machineName} to delete its folder from here.` };
      }
      await this.callMachine(target, "projects.remove", { projectId }, { retryOnConnectionError: false });
      outcome = { status: "removed", folder: "kept", outsideLaneFolders: [] };
    } else {
      outcome = (await this.callMachine(target, "projects.removeCopy", {
        projectId,
        deleteFolder: request.deleteFolder,
        stateToken: request.stateToken,
        acceptWork: request.acceptWork,
      }, {
        // A delete is never replayed: a second try after a dropped answer
        // could act on a copy nobody checked.
        retryOnConnectionError: false,
        timeoutMs: PROJECT_REMOVAL_TIMEOUT_MS,
      })) as ProjectRemovalOutcome;
    }
    if (outcome.status !== "refused") this.dropProject(target.id, projectId);
    return outcome;
  }

  private requireConnectedTargetForRemoval(targetId: string): RemoteRuntimeTarget {
    const target = this.requireTarget(targetId);
    if (this.statusById.get(target.id)?.state !== "connected") {
      throw new AdeExpectedError(`${target.name || target.hostname} is offline. It keeps its copy and its entry.`, "user");
    }
    return target;
  }

  private dropProject(targetId: string, projectId: string): void {
    const projects = this.statusById.get(targetId)?.projects;
    if (!projects?.some((project) => project.projectId === projectId)) return;
    this.mergeStatus(targetId, { projects: projects.filter((project) => project.projectId !== projectId) });
  }

  private async callProjectIconMethod(
    targetId: string,
    method: "projects.setIcon" | "projects.removeIcon",
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const target = this.requireTarget(targetId);
    const unsupported = () =>
      this.statusById.get(target.id)?.capabilities?.machineProjects?.setIcon === false;
    const updateMessage = `Update ADE on ${target.name || target.hostname} to change its icon.`;
    // Known-old host: say so without a round trip.
    if (unsupported()) throw new Error(updateMessage);
    try {
      return await this.callMachine(target, method, params, {
        // Writes are not idempotent from the caller's view; never replay.
        retryOnConnectionError: false,
      });
    } catch (error) {
      // The first call may be what connected us and learned the capability.
      if (unsupported()) throw new Error(updateMessage);
      throw error;
    }
  }

  private patchProjectIcon(
    targetId: string,
    rootPath: string,
    icon: ProjectIcon | null,
  ): void {
    const current = this.statusById.get(targetId);
    const projects = current?.projects;
    if (!projects?.some((project) => project.rootPath === rootPath)) return;
    this.mergeStatus(targetId, {
      projects: projects.map((project) =>
        project.rootPath === rootPath ? { ...project, icon } : project
      ),
    });
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
    // Said once, to the caller of this clone; the stored project list never keeps it.
    return asRecord(value).githubSignInMissing === true ? { ...project, githubSignInMissing: true } : project;
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

  /**
   * How this target accepts a staged chat attachment, and how large one may be.
   *
   * `"upload"` means the host advertised the streamed HTTP route and the socket
   * is direct enough to use it. `"base64"` is every other case — SSH targets,
   * relay-routed sockets, and hosts predating the feature — and keeps the
   * legacy base64 command with its smaller ceiling.
   *
   * The answer is already a {@link ChatAttachmentStagingMode}, so the renderer
   * routes on it directly. It used to be a separate `"command"` vocabulary that
   * preload renamed on the way out, which meant two names for one fact.
   * `"copy"` is the one mode this can never return: it is a property of the
   * caller (same machine), not of the target.
   */
  async getAttachmentUploadCapability(
    targetId: string,
  ): Promise<ChatAttachmentStagingMode> {
    const legacy: ChatAttachmentStagingMode = {
      mode: "base64",
      maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
    };
    try {
      const route = await this.pool.getAttachmentUploadRoute(targetId);
      if (!route) return legacy;
      return {
        mode: "upload",
        maxBytes: Math.min(route.maxBytes, MAX_CHAT_ATTACHMENT_BYTES),
      };
    } catch {
      // A target that is not connected cannot be probed; the caller degrades to
      // the base64 path, which reconnects on its own.
      return legacy;
    }
  }

  /**
   * Stage an attachment on a paired machine by streaming its bytes over HTTP.
   *
   * Two legs, in this order and only this order: mint a single-use ticket over
   * the authenticated sync socket, then POST the body with that ticket. The
   * HTTP leg never carries the pairing secret, and a ticket that is not spent
   * expires on its own.
   */
  async uploadChatAttachment(args: {
    targetId: string;
    projectId: string;
    sourcePath: string;
    filename: string;
  }): Promise<{ path: string }> {
    let maxBytes = LEGACY_MAX_CHAT_ATTACHMENT_BYTES;
    try {
      const route = await this.pool.getAttachmentUploadRoute(args.targetId);
      if (!route) throw new Error("This machine does not accept attachment uploads.");
      maxBytes = Math.min(maxBytes, route.maxBytes);
      const minted = await this.callAction(args.targetId, args.projectId, {
        domain: "chat",
        action: "createAttachmentUpload",
        args: { filename: args.filename },
      });
      const ticket = parseRemoteAttachmentUploadTicket(minted.result);
      if (!ticket) throw new Error("This machine returned an unusable attachment upload ticket.");
      maxBytes = Math.min(maxBytes, ticket.maxBytes);
      return await uploadRemoteAttachment({ route, ticket, sourcePath: args.sourcePath });
    } catch (error) {
      captureError(error, { fingerprint: ["chat", "attachment_upload_failed"], handled: true, level: "warning" });
      // A direct HTTP route can fail while the authenticated command still
      // works. Recover once, on this same target/project, within both limits.
      // A missing source cannot recover; keep the original upload diagnosis.
      const stat = await fs.promises.stat(args.sourcePath).catch(() => null);
      if (!stat?.isFile() || stat.size > maxBytes) throw error;
      const chunks: Buffer[] = [];
      let size = 0;
      // Include one extra byte to detect a file growing after the stat while
      // bounding the read even if another process keeps appending to it.
      for await (const chunk of fs.createReadStream(args.sourcePath, { end: maxBytes })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) throw error;
        chunks.push(bytes);
      }
      const saved = await this.callAction(args.targetId, args.projectId, {
        domain: "chat", action: "saveTempAttachment",
        args: { data: Buffer.concat(chunks).toString("base64"), filename: args.filename },
      });
      const stagedPath = asRecord(saved.result).path;
      if (typeof stagedPath !== "string" || !stagedPath.trim()) {
        throw new Error("The machine did not return an attachment path.");
      }
      return { path: stagedPath };
    }
  }

  /**
   * Stage attachment bytes that have no file behind them, such as a pasted
   * image, through the same two-leg upload a picked file takes.
   *
   * `maxBytes` is what the machine advertised for its upload route. The ceiling
   * is the smaller of that and the product cap, because the host knows its own
   * route limit. The encoded length is checked first, so an oversized paste is
   * refused before it is decoded into a second copy.
   */
  async uploadChatAttachmentBytes(args: {
    targetId: string;
    projectId: string;
    data: string;
    filename: string;
    maxBytes: number;
  }): Promise<{ path: string }> {
    const limit = Number.isFinite(args.maxBytes) && args.maxBytes > 0
      ? Math.min(args.maxBytes, MAX_CHAT_ATTACHMENT_BYTES)
      : MAX_CHAT_ATTACHMENT_BYTES;
    const tooLarge = (bytes: number) => new Error(attachmentTooLargeMessage(args.filename, bytes, limit));
    if (args.data.length > maxBase64EncodedLength(limit)) {
      throw tooLarge(approxDecodedBytes(args.data.length));
    }
    const bytes = Buffer.from(args.data, "base64");
    if (bytes.byteLength > limit) throw tooLarge(bytes.byteLength);
    return await withTempAttachmentFile(bytes, (sourcePath) => this.uploadChatAttachment({
      targetId: args.targetId,
      projectId: args.projectId,
      sourcePath,
      filename: args.filename,
    }));
  }

  /**
   * The id the machine routes a project by. A pin made from a saved chat can
   * name the project by an id the machine never had (older cloud computers
   * uploaded the project's database id); the pin's folder finds it there.
   * Anything else goes as asked, and the machine answers for it.
   */
  private projectIdOnMachine(
    targetId: string,
    projectId: string,
    projectRootPath: string | null | undefined,
    known: readonly RemoteRuntimeProjectRecord[] | null = null,
  ): string {
    if (!projectRootPath) return projectId;
    const projects = known ?? this.statusById.get(targetId)?.projects;
    return findMachineProject(projects, { projectId, rootPath: projectRootPath })?.projectId ?? projectId;
  }

  /**
   * `projectIdOnMachine`, for a call about to go out. A machine this app holds
   * no project list for (awake, but not connected here yet) is asked for it
   * first; a failure there is the call's failure.
   */
  private async routedProjectId(
    target: RemoteRuntimeTarget,
    projectId: string,
    projectRootPath: string | null | undefined,
    known: readonly RemoteRuntimeProjectRecord[] | null = null,
    onPhase?: (phase: RemoteEventSetupPhase) => void,
  ): Promise<string> {
    if (!projectRootPath) return this.noteUnroutedProjectId(target.id, projectId, false);
    let projects = known;
    if (!projects && !this.statusById.get(target.id)?.projects?.length) {
      projects = coerceProjects(await this.pool.projectsForTarget(target, { onPhase }));
      this.mergeStatus(target.id, { projects: [...projects] });
    }
    return this.noteUnroutedProjectId(
      target.id,
      this.projectIdOnMachine(target.id, projectId, projectRootPath, projects),
      true,
    );
  }

  /**
   * A machine names its projects `project_<hash>`. An id of another shape (the
   * app's own project id) that found no record by folder goes out as asked, and
   * the machine refuses it as an unknown project. Log the first one for each
   * machine and id, with the pin's shape, to find the caller that sent it.
   */
  private noteUnroutedProjectId(targetId: string, projectId: string, hadRootPath: boolean): string {
    if (projectId.startsWith("project_")) return projectId;
    const key = `${targetId}\u0000${projectId}`;
    if (this.unroutedProjectIdsLogged.has(key)) return projectId;
    this.unroutedProjectIdsLogged.add(key);
    this.options.logger?.info("remote.project_id_unrouted", {
      targetId,
      projectId,
      hadRootPath,
      knownProjectCount: this.statusById.get(targetId)?.projects?.length ?? 0,
    });
    return projectId;
  }

  /** A machine woken for a call lists its projects, as a Connect does. */
  private noteWokenProjects(targetId: string, result: RemoteRuntimeConnectResult): RemoteRuntimeProjectRecord[] {
    if (this.registry.get(targetId) && !this.manuallyDisconnectedTargetIds.has(targetId)) {
      this.mergeStatus(targetId, { projects: result.projects });
    }
    return result.projects;
  }

  /**
   * A machine-scope call (a computer's own settings, `shared/machineScope.ts`)
   * to a brain that predates the route: it would answer "unknown project", so
   * it gets the sentence that says what to do instead. Null for any other
   * call. Before the machine's capabilities are known, only its answer
   * (`error`, "unknown project") tells.
   */
  private machineScopeRefusal(targetId: string, projectId: string, error?: unknown): Error | null {
    if (projectId !== MACHINE_SCOPE_PROJECT_ID) return null;
    const capabilities = this.statusById.get(targetId)?.capabilities;
    const older = capabilities ? capabilities.machineScope !== true : isMachineScopeUnknownProjectError(error);
    if (!older) return null;
    const known = this.registry.get(targetId);
    return new Error(machineScopeUpdateMessage(known?.name?.trim() || known?.hostname?.trim() || "That computer"));
  }

  /**
   * `run` for a call that may be a machine-scope call (`machineScopeRefusal`):
   * refused up front when the machine is known to predate the route, and its
   * "unknown project" answer turned into that sentence. Any other failure
   * goes to `onFailure` (a refusal is the machine answering, not a failed
   * connection) and is thrown as it was.
   */
  private async withMachineScopeRefusal<T>(
    targetId: string,
    projectId: string,
    run: () => Promise<T>,
    onFailure: (error: unknown) => void,
  ): Promise<T> {
    const refusedBefore = this.machineScopeRefusal(targetId, projectId);
    if (refusedBefore) throw refusedBefore;
    try {
      return await run();
    } catch (error) {
      const refused = this.machineScopeRefusal(targetId, projectId, error);
      if (refused) throw refused;
      onFailure(error);
      throw error;
    }
  }

  async callAction(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeActionRequest,
    options?: { projectRootPath?: string | null },
  ): Promise<RemoteRuntimeActionResult> {
    // Sending to a chat or changing anything on a sleeping cloud machine wakes
    // it first, and waits for it to come back. The app's own background writes don't.
    const wakes = adeActionAccess(request.domain, request.action) === "write"
      && !isBackgroundAdeWrite(request.domain, request.action);
    // Read after any wake: the woken machine's own list, else the last one known.
    let wokenProjects: RemoteRuntimeProjectRecord[] | null = null;
    const routedProjectId = (machine: RemoteRuntimeTarget) =>
      this.routedProjectId(machine, projectId, options?.projectRootPath, wokenProjects);
    if (!this.pool.hasEntry(targetId) && wakes) {
      const sleeping = this.registry.get(targetId);
      // The same guards as any implicit use, but for the reconnect backoff a
      // sleeping box has run up: nothing is woken that the call may not reach.
      if (sleeping) {
        await this.assertAccountOwnershipAuthorized(sleeping);
        if (this.options.explicitConnectOnly && !this.explicitlyConnectedTargetIds.has(targetId)) {
          throw new Error(EXPLICIT_CONNECT_ONLY_MESSAGE);
        }
        if (this.isManuallyDisconnected(sleeping)) throw new Error(REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE);
      }
      if (sleeping && await this.wakeForUse(sleeping)) {
        this.clearAutomaticReconnectState(targetId);
        wokenProjects = this.noteWokenProjects(targetId, await this.connectWokenMachine(sleeping));
      } else if (this.asleepChecks.isResting(targetId)) {
        // Not woken by this app: another device woke it already. The rest
        // ends, and the dial below finds out (a failed one asks again).
        this.clearAutomaticReconnectState(targetId);
      }
    }
    const target = await this.requireTargetForImplicitUse(targetId);
    return await this.withMachineScopeRefusal(targetId, projectId, async () => {
      let result: RemoteRuntimeActionResult;
      try {
        result = await this.pool.callActionForTarget(target, await routedProjectId(target), request);
      } catch (error) {
        // A connection that looked open to a box that is asleep: wake it. The
        // call is sent once more only when sending it twice is safe, or when
        // it never went out; otherwise its unknown outcome stands, and the
        // person's retry reaches the woken machine.
        if (!wakes || !(await this.wakeForUse(target))) throw error;
        this.clearAutomaticReconnectState(targetId);
        wokenProjects = this.noteWokenProjects(targetId, await this.connectWokenMachine(target));
        if (error instanceof RemoteActionOutcomeUnknownError
          && !isRetriableAfterSleep(request, this.statusById.get(targetId)?.capabilities?.clientSendDedupe === true)) throw error;
        result = await this.pool.callActionForTarget(target, await routedProjectId(target), request);
      }
      this.mergeStatus(targetId, {
        state: "connected",
        lastError: null,
        lastAttemptedAt: Date.now(),
      });
      this.clearAutomaticReconnectState(targetId);
      return result;
    }, (error) => this.markCallFailure(targetId, error));
  }

  /**
   * About eight event pumps (chat, PTY, PR, browser and others) poll one
   * binding. When two ask for the same window at the same time, they share one
   * read, so the host does not send the same reply twice on one socket.
   */
  streamEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    options?: { projectRootPath?: string | null },
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const key = JSON.stringify([
      targetId,
      projectId,
      request.cursor ?? null,
      request.limit ?? null,
      request.category ?? null,
      request.replay ?? null,
    ]);
    const inFlight = this.inFlightStreamEvents.get(key);
    if (inFlight) return inFlight;
    const read = this.readStreamEvents(targetId, projectId, request, options).finally(() => {
      if (this.inFlightStreamEvents.get(key) === read) this.inFlightStreamEvents.delete(key);
    });
    this.inFlightStreamEvents.set(key, read);
    return read;
  }

  private async readStreamEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest,
    options?: { projectRootPath?: string | null },
  ): Promise<RemoteRuntimeStreamEventsResult> {
    // A read that finishes after its deadline changes no status: a newer
    // poll owns the machine's status by then.
    return await this.withEventSetupDeadline(targetId, "read", async (notePhase, gaveUp) => {
      const target = await this.requireTargetForImplicitUse(targetId);
      return await this.withMachineScopeRefusal(targetId, projectId, async () => {
        const result = await this.pool.streamEventsForTarget(
          target,
          await this.routedProjectId(target, projectId, options?.projectRootPath, null, notePhase),
          request,
          { onPhase: notePhase },
        );
        if (gaveUp()) return result;
        this.mergeStatus(targetId, {
          state: "connected",
          lastError: null,
          lastAttemptedAt: Date.now(),
        });
        this.clearAutomaticReconnectState(targetId);
        return result;
      }, (error) => {
        if (!gaveUp()) this.markCallFailure(targetId, error);
      });
    });
  }

  /**
   * An event read or subscription, bounded as a whole. Every step under it
   * has its own bound, but a dial can try several routes or join a long SSH
   * install, and a renderer poll must not sit on that: past
   * REMOTE_RUNTIME_EVENT_SETUP_TIMEOUT_MS it fails naming the step it was on,
   * and the pump polls again (joining the dial, which keeps going).
   */
  private withEventSetupDeadline<T>(
    targetId: string,
    kind: "read" | "subscribe",
    run: (notePhase: (phase: RemoteEventSetupPhase) => void, isAbandoned: () => boolean) => Promise<T>,
    onLateResult?: (value: T) => void,
  ): Promise<T> {
    const known = this.registry.get(targetId);
    const machineName = known?.name?.trim() || known?.hostname?.trim() || "that computer";
    return runWithEventSetupDeadline({
      machineName,
      run,
      onLateResult,
      onSettled: ({ timedOut, clock }) => {
        const totalMs = clock.totalMs();
        if (!timedOut && totalMs < REMOTE_RUNTIME_EVENT_SETUP_SLOW_MS) return;
        const meta = {
          kind,
          transport: known?.transport ?? "ssh",
          phase: clock.current(),
          totalMs,
          phases: clock.summary(),
        };
        if (timedOut) {
          // Breadcrumb plus a budgeted Sentry Log, keyed by the step that hung.
          forwardSignalToSentry("remote.event_setup_timed_out", meta, `remote.event_setup_timed_out:${meta.phase}`);
          this.options.logger?.info("remote.event_setup_timed_out", { targetId, ...meta });
        } else {
          addSentryBreadcrumb("remote", "remote.event_setup_slow", meta);
        }
      },
    });
  }

  async subscribeEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
    onEnded?: () => void,
    onSubscribed?: (result: RemoteRuntimeStreamEventsResult) => void,
    options?: { projectRootPath?: string | null },
  ): Promise<() => void> {
    // A subscription acknowledged after the deadline is closed again
    // (`onLateResult`): the caller gave up on it and holds no handle to it.
    return await this.withEventSetupDeadline(
      targetId,
      "subscribe",
      async (notePhase, gaveUp) => {
        const target = await this.requireTargetForImplicitUse(targetId);
        return await this.withMachineScopeRefusal(targetId, projectId, async () => {
          const cleanup = await this.pool.subscribeEventsForTarget(
            target,
            await this.routedProjectId(target, projectId, options?.projectRootPath, null, notePhase),
            request,
            (event, eventEpoch) => {
              if (!gaveUp()) onEvent(event, eventEpoch);
            },
            () => {
              if (!gaveUp()) onEnded?.();
            },
            (result) => {
              if (!gaveUp()) onSubscribed?.(result);
            },
            { onPhase: notePhase },
          );
          if (gaveUp()) return cleanup;
          this.mergeStatus(targetId, {
            state: "connected",
            lastError: null,
            lastAttemptedAt: Date.now(),
          });
          this.clearAutomaticReconnectState(targetId);
          return cleanup;
        }, (error) => {
          if (!gaveUp()) this.markCallFailure(targetId, error);
        });
      },
      (lateCleanup) => lateCleanup(),
    );
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
      this.clearAutomaticReconnectState(targetId);
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
      this.clearAutomaticReconnectState(targetId);
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
    options: { retryOnConnectionError?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const target = await this.requireTargetForImplicitUse(targetId);
    return (await this.callMachine(target, method, params, options)) as T;
  }

  dispose(): void {
    this.stopAutoconnect();
    this.stopHostReturnWatches();
    this.pool.dispose();
    this.latencyProbeTargetIds.clear();
    this.automaticReconnectFailuresByTargetId.clear();
    this.automaticReconnectRetryAtByTargetId.clear();
    this.pairedFallbackSshTrustByTargetId.clear();
    this.listeners.clear();
  }

  private async maintainSavedConnections(
    options: { pingTimeoutMs?: number } = {},
  ): Promise<void> {
    await this.reconcileAuthorizedAccountOwnership();
    for (const target of this.registry.list()) {
      if (!shouldAutoconnectTarget(target)) continue;
      if (this.isManuallyDisconnected(target) || this.isHeldForUserAction(target.id)) continue;
      if (!this.automaticReconnectRetryIsDue(target.id)) continue;
      if (this.asleepChecks.isResting(target.id)) {
        // Still asleep: no dial, ask again later. Awake (something else woke
        // it), or no longer a cloud computer: the dial below brings it back.
        const stillAsleep = await this.asleepChecks.stillAsleep(target);
        if (!this.asleepChecks.isResting(target.id)) continue;
        if (stillAsleep) {
          this.automaticReconnectRetryAtByTargetId.set(target.id, Date.now() + CLOUD_ASLEEP_RECHECK_MS);
          continue;
        }
        this.asleepChecks.endRest(target.id);
      }
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
          if (await this.asleepAfterFailure(target.id, error)) continue;
          if (!isImplicitConnectionFailure(error)) continue;
          this.pool.disconnect(target.id);
          // Without the 30 s maintenance (a dev app, after a wake) the
          // redials for a dropped link bring it back instead of one dial.
          const { recovery, watching } = this.beginRecoveryAfterDrop(target);
          this.mergeStatus(target.id, {
            state: "error",
            ...errorStatusPatch(error, describeHostWentAway(target.name, recovery)),
            recovery,
          });
          if (watching) continue;
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
    options: { retryOnConnectionError?: boolean; timeoutMs?: number } = {},
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
      this.clearAutomaticReconnectState(target.id);
      return result;
    } catch (error) {
      this.markCallFailure(target.id, error);
      throw error;
    }
  }

  private requireTarget(targetId: string): RemoteRuntimeTarget {
    const target = this.registry.get(targetId);
    // Removed (or never saved here) while a view still held its id: the
    // caller's to fix, as `requireRemoteTarget` in runtimeBridge says.
    if (!target) throw new AdeExpectedError(REMOTE_TARGET_NOT_FOUND_MESSAGE, "user");
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
    if (this.options.explicitConnectOnly && !this.explicitlyConnectedTargetIds.has(targetId)) {
      throw new Error(EXPLICIT_CONNECT_ONLY_MESSAGE);
    }
    const target = this.registry.get(targetId);
    // The in-memory set covers a machine another ADE on this computer took,
    // which is never written to the saved machine.
    if (
      this.manuallyDisconnectedTargetIds.has(targetId)
      || target?.manuallyDisconnectedAt != null
    ) {
      throw new Error(REMOTE_RUNTIME_MANUALLY_DISCONNECTED_MESSAGE);
    }
    // A live or opening connection serves the call. Without one, the call
    // would dial, so it waits for the same backoff the automatic reconnect
    // keeps; every poll of a window used to dial on its own.
    if (this.pool.hasEntry(targetId)) return;
    // A stopped machine says why, with the failure that stopped it.
    if (this.pool.needsUserAction(targetId)) this.pool.assertConnectNotBackingOff(targetId);
    const retryAt = this.automaticReconnectRetryAtByTargetId.get(targetId);
    if (retryAt != null && retryAt > Date.now()) {
      const status = this.statusById.get(targetId);
      throw new RemoteConnectBackoffError(
        this.asleepChecks.isResting(targetId)
          ? "the computer is asleep"
          : status?.lastErrorInfo?.message ?? status?.lastError ?? "the machine did not answer",
        retryAt,
      );
    }
    this.pool.assertConnectNotBackingOff(targetId);
  }

  private isManuallyDisconnected(target: RemoteRuntimeTarget): boolean {
    return this.manuallyDisconnectedTargetIds.has(target.id) || target.manuallyDisconnectedAt != null;
  }

  /** The last connect failed in a way only the person can fix (SSH sign-in, host key). */
  private isHeldForUserAction(targetId: string): boolean {
    return !this.pool.hasEntry(targetId) && this.pool.needsUserAction(targetId);
  }

  /** Says so in the status when ADE stopped retrying after this failure. */
  private withRetryNotice(targetId: string, message: string): string {
    return this.isHeldForUserAction(targetId) ? `${message} ${REMOTE_CONNECT_STOPPED_NOTICE}` : message;
  }

  /**
   * The 30 s saved-connection maintenance redials this machine on its own
   * (installed apps), with the automatic-reconnect backoff and no time limit.
   */
  private savedConnectionMaintenanceOwns(target: RemoteRuntimeTarget): boolean {
    return !this.options.explicitConnectOnly
      && this.autoconnectTimer != null
      && shouldAutoconnectTarget(target)
      && !this.isManuallyDisconnected(target);
  }

  /**
   * Whether this app may redial a link it had open that dropped: the person
   * did not disconnect it or turn "Reconnect automatically" off, and a dev
   * app connected it in this run (it never takes a machine on its own).
   */
  private canWatchForHostReturn(target: RemoteRuntimeTarget): boolean {
    if (this.isManuallyDisconnected(target) || !shouldAutoconnectTarget(target)) return false;
    return !this.options.explicitConnectOnly || this.explicitlyConnectedTargetIds.has(target.id);
  }

  /**
   * A link this app had open dropped because the machine went away. The saved
   * connection's 30 s maintenance brings it back when it owns the machine;
   * otherwise this app redials on its own when it may, and when it may not,
   * the person reconnects.
   */
  private beginRecoveryAfterDrop(
    target: RemoteRuntimeTarget,
  ): { recovery: HostWentAwayRecovery; watching: boolean } {
    if (this.savedConnectionMaintenanceOwns(target)) return { recovery: "reconnecting", watching: false };
    if (!this.canWatchForHostReturn(target)) return { recovery: "waiting_for_user", watching: false };
    this.hostReturnWatches.start(target.id);
    return { recovery: "reconnecting", watching: true };
  }

  /** The watch window ran out: say that the app now waits for the person. */
  private hostReturnWatchExpired(targetId: string): void {
    const target = this.registry.get(targetId);
    const status = this.statusById.get(targetId);
    if (!target || status?.state !== "error") return;
    const waiting = describeHostWentAway(target.name, "waiting_for_user");
    this.mergeStatus(targetId, {
      lastError: waiting,
      lastErrorInfo: { ...(status.lastErrorInfo ?? { kind: "generic" as const }), message: waiting },
      recovery: "waiting_for_user",
    });
  }

  /** A redial failed. Returns the delay before the next one, or null to stop. */
  private hostReturnAttemptFailed(targetId: string, error: unknown, attempts: number): number | null {
    if (!this.hostReturnCanContinue(targetId, error)) {
      // The person has to fix something; the status already says what.
      // Returning null stops the watch.
      const status = this.statusById.get(targetId);
      if (status?.recovery === "reconnecting") this.mergeStatus(targetId, { recovery: null });
      return null;
    }
    const target = this.registry.get(targetId);
    if (target && !isConnectionBackoffThrottle(error)) {
      // The dial's own failure stays as the detail; the headline says the
      // app keeps trying.
      this.mergeStatus(targetId, {
        state: "error",
        ...errorStatusPatch(error, describeHostWentAway(target.name, "reconnecting")),
        recovery: "reconnecting",
      });
    }
    const retryAt = this.automaticReconnectRetryAtByTargetId.get(targetId);
    const now = Date.now();
    return retryAt != null && retryAt > now ? retryAt - now : automaticReconnectBackoffMs(attempts);
  }

  /** A failure the machine coming back can fix, as opposed to one only the person can. */
  private hostReturnCanContinue(targetId: string, error: unknown): boolean {
    if (isConnectionBackoffThrottle(error)) return !this.pool.needsUserAction(targetId);
    if (error instanceof PairedRuntimeRelayAuthRequiredError) return false;
    if (!this.isConnectionFailure(targetId, error) || this.pool.needsUserAction(targetId)) return false;
    const failure = this.statusById.get(targetId)?.lastErrorInfo?.failure;
    return failure !== "pairing" && failure !== "authentication" && failure !== "identity";
  }

  /** What a failed call or connect leaves in `recovery`. */
  private recoveryAfterFailure(targetId: string): RemoteRuntimeConnectionRecovery | null {
    const target = this.registry.get(targetId);
    if (!target || this.isHeldForUserAction(targetId) || this.isManuallyDisconnected(target)) return null;
    if (this.hostReturnWatches.has(targetId) || this.savedConnectionMaintenanceOwns(target)) {
      return "reconnecting";
    }
    return this.statusById.get(targetId)?.recovery === "waiting_for_user" ? "waiting_for_user" : null;
  }

  /** Whether a sleeping cloud machine was woken for this use (see the option). */
  private async wakeForUse(target: RemoteRuntimeTarget): Promise<boolean> {
    if (!this.options.wakeForUse) return false;
    return await this.options.wakeForUse(target);
  }

  /** Connects a machine that is waking: its relay route comes back a few seconds after the wake. */
  private async connectWokenMachine(target: RemoteRuntimeTarget): Promise<RemoteRuntimeConnectResult> {
    const deadline = Date.now() + WOKEN_MACHINE_CONNECT_WAIT_MS;
    for (;;) {
      try {
        return await this.pool.connect(target, { bypassFailureBackoff: true, initiatedBy: "user" });
      } catch (error) {
        // Waiting fixes a relay that isn't up yet, not a sign-in or a pairing.
        if (error instanceof PairedRuntimeRelayAuthRequiredError || this.pool.needsUserAction(target.id)) throw error;
        if (Date.now() + WOKEN_MACHINE_RETRY_MS > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, WOKEN_MACHINE_RETRY_MS));
      }
    }
  }

  private clearAutomaticReconnectState(targetId: string): void {
    this.automaticReconnectFailuresByTargetId.delete(targetId);
    this.automaticReconnectRetryAtByTargetId.delete(targetId);
    this.asleepChecks.noteAlive(targetId);
  }

  /**
   * A call or a dial failed. When it failed the way a sleeping cloud computer
   * fails, asks whether the machine is one and rests the connection when it
   * is. Null when nothing was asked (not a cloud computer, or an answer from
   * the machine, which proves it awake).
   */
  private asleepAfterFailure(targetId: string, error: unknown): Promise<boolean> | null {
    if (!this.options.asleepForUse || isConnectionBackoffThrottle(error)) return null;
    if (
      !isRuntimeTransportTimeoutError(error)
      && !(error instanceof RemoteActionOutcomeUnknownError)
      && !this.isConnectionFailure(targetId, error)
    ) return null;
    const target = this.registry.get(targetId);
    return target ? this.asleepChecks.afterFailure(target) : null;
  }

  /**
   * The cloud computer is asleep: not an error and nothing to redial. The link
   * closes and the status says idle, so the lists show its saved chats and no
   * read goes out. A person's use wakes it; the maintenance asks again later.
   */
  private restAsleep(target: RemoteRuntimeTarget): void {
    this.pool.disconnect(target.id);
    this.hostReturnWatches.stop(target.id);
    this.automaticReconnectFailuresByTargetId.delete(target.id);
    this.automaticReconnectRetryAtByTargetId.set(target.id, Date.now() + CLOUD_ASLEEP_RECHECK_MS);
    this.mergeStatus(target.id, { state: "idle", lastError: null, recovery: null });
    this.options.logger?.info("remote.cloud_computer_asleep", { targetId: target.id });
  }

  private automaticReconnectRetryIsDue(targetId: string): boolean {
    const retryAt = this.automaticReconnectRetryAtByTargetId.get(targetId);
    if (retryAt == null || retryAt <= Date.now()) {
      this.automaticReconnectRetryAtByTargetId.delete(targetId);
      return true;
    }
    return false;
  }

  /**
   * Classify a failure from an RPC call made over an already-established
   * connection. If the response came back over a live channel, the host is
   * reachable and the error is application-level (e.g. a host-side SQL or
   * validation failure). Such errors must NOT flip the connection to
   * "error"/reconnecting — doing so surfaces a false "host is unreachable"
   * toast and a reconnect loop for what is really a per-action failure. Only
   * genuine transport failures update the connection status and reconnect
   * backoff state; everything else is left to rethrow to the caller untouched.
   */
  private markCallFailure(targetId: string, error: unknown): void {
    const asleep = this.asleepAfterFailure(targetId, error);
    if (!asleep) {
      this.recordCallFailure(targetId, error);
      return;
    }
    // A sleeping cloud computer is not a failed connection. The status waits
    // for the answer, and takes the failure only if the machine is awake and
    // nothing has reached it since.
    const stamp = this.asleepChecks.aliveStamp(targetId);
    const disconnectGeneration = this.getDisconnectGeneration(targetId);
    void asleep.then((isAsleep) => {
      // A Disconnect pressed while the question was out stays a disconnect.
      if (
        !isAsleep
        && this.asleepChecks.aliveStamp(targetId) === stamp
        && this.isDisconnectGenerationCurrent(targetId, disconnectGeneration)
      ) this.recordCallFailure(targetId, error);
    });
  }

  private recordCallFailure(targetId: string, error: unknown): void {
    if (!this.isConnectionFailure(targetId, error)) return;
    // A refusal to dial changes nothing; the status already holds the failure
    // that started the wait, with its kind (SSH sign-in, unreachable).
    if (isConnectionBackoffThrottle(error)) return;
    this.mergeStatus(targetId, {
      state: "error",
      ...errorStatusPatch(
        error,
        this.withRetryNotice(targetId, this.noteAutomaticReconnectFailure(targetId, error)),
      ),
      lastAttemptedAt: Date.now(),
      recovery: this.recoveryAfterFailure(targetId),
    });
  }

  /** A failure of the connection, not an answer from the machine. */
  private isConnectionFailure(targetId: string, error: unknown): boolean {
    return isImplicitConnectionFailure(error) || this.pool.isLastConnectFailure(targetId, error);
  }

  private recordImplicitFailure(targetId: string, error: unknown): string {
    if (!this.isConnectionFailure(targetId, error)) return errorMessage(error);
    return this.noteAutomaticReconnectFailure(targetId, error);
  }

  private noteAutomaticReconnectFailure(
    targetId: string,
    error: unknown,
  ): string {
    // Calls that share one failed dial each report it. Count the dial once,
    // or a burst of polls would jump the wait straight to its maximum.
    const pendingRetryAt = this.automaticReconnectRetryAtByTargetId.get(targetId);
    if (pendingRetryAt != null && pendingRetryAt > Date.now()) return errorMessage(error);
    const failureCount =
      (this.automaticReconnectFailuresByTargetId.get(targetId) ?? 0) + 1;
    this.automaticReconnectFailuresByTargetId.set(targetId, failureCount);
    const retryInMs = automaticReconnectBackoffMs(failureCount);
    this.automaticReconnectRetryAtByTargetId.set(targetId, Date.now() + retryInMs);
    // Nothing else on this machine records a failed reconnect, which left a
    // machine that stayed "offline" for minutes with no trail to follow. Once
    // per outage, after a minute of failures: a machine that is simply asleep
    // or switched off should not log every retry.
    if (failureCount === RECONNECT_FAILURES_BEFORE_SIGNAL) {
      forwardSignalToSentry("remote.reconnect_failed", {
        failureCount,
        retryInMs,
        error: errorMessage(error).slice(0, 300),
      });
    }
    return errorMessage(error);
  }

  private describeDialTarget(targetId: string) {
    const target = this.registry.get(targetId);
    if (!target) return null;
    const credentials = target.pairedMachine ? this.pairedStore.getForReference(target.pairedMachine) : null;
    return {
      deviceRef: syncDeviceTelemetryRef(credentials?.deviceId),
      peerDeviceRef: syncDeviceTelemetryRef(credentials?.hostIdentity.deviceId),
      peerVersion: target.runtimeBinaryVersion ?? null,
      lastConnectedAt: target.lastConnectedAt ?? null,
    };
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
    const next = {
      ...current,
      ...normalizedPatch,
      state: (normalizedPatch.state ??
        current.state ??
        "idle") as RemoteRuntimeConnectionState,
    };
    // Who brings a failed link back means nothing once it is up or idle, and
    // must not come back with a later, unrelated failure.
    if (next.state === "connected" || next.state === "idle") next.recovery = null;
    this.statusById.set(targetId, next);
    // Every successful call re-stamps `lastAttemptedAt` on a healthy machine.
    // Broadcasting that told every window "the connections changed", and the
    // cross-machine lane union answered each one with a status read of every
    // machine -- itself a call, so the loop ran several times a second. Only a
    // change a window can act on is broadcast.
    // A re-read project list or error is a fresh object even when nothing in
    // it changed, so structured fields compare by content.
    const previous: Record<string, unknown> = current;
    const meaningful = Object.entries(next).some(
      ([key, value]) => key !== "lastAttemptedAt" && !sameStatusValue(previous[key], value),
    );
    if (meaningful) this.emit();
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
