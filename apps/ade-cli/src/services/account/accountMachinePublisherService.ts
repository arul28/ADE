import {
  createSyncAccountDirectoryHealth,
  type AdeAccountMachineEndpoint,
  type SyncAccountDirectoryHealth,
  type SyncRoleSnapshot,
  type SyncRouteHealth,
} from "../../../../desktop/src/shared/types";
import {
  readAccountDirectoryHttpReason,
  resolveTrustedAccountDirectoryBaseUrl,
  shouldIgnoreDevelopmentAccountDirectoryUrl,
  warnDevelopmentClerkIgnored,
} from "../../../../desktop/src/shared/accountDirectory";
import {
  getSignedInAccountAccessToken,
  type AccountAuthStatus,
  type AccountSessionReadState,
} from "./accountAuthService";
import {
  getSharedAccountAuthService,
  resolveOfficialAccountDirectoryBaseUrl,
} from "./sharedAccountAuthService";

export const ACCOUNT_MACHINE_HEARTBEAT_MS = 30_000;
export const ACCOUNT_MACHINE_RELAY_STATE_POLL_MS = 2_000;
// Keep outage recovery comfortably inside the directory's 90-second online
// window while bounding sustained failures at a 20-second request cadence.
export const ACCOUNT_MACHINE_RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

export type AccountMachineRegistration = {
  machineKey: string;
  deviceId: string;
  name: string;
  platform: string;
  deviceType: string;
  pubkey: null;
  reachableEndpoints: AdeAccountMachineEndpoint[];
  /**
   * Asks a compatible directory to retain its stored Relay endpoint when this
   * heartbeat catches the independently asynchronous Relay components between
   * ready states. The directory scopes retention to the authenticated owner
   * and machine key; current endpoints remain authoritative for every other
   * route kind.
   */
  retainRelayEndpoints?: true;
};

type AccountMachinePublisherLogger = {
  warn(message: string, meta?: Record<string, unknown>): void;
};

type BrainAccountMachinePublisherLogger = AccountMachinePublisherLogger & {
  info(message: string, meta?: Record<string, unknown>): void;
};

export type AccountMachineRegistrationSnapshot = Pick<
  SyncRoleSnapshot,
  "role" | "runtimeRole" | "runtimeName" | "pairingConnectInfo"
> & {
  routeHealth: Pick<SyncRouteHealth, "listener" | "tailscale" | "relay">;
};

type PublisherAccountStatus = Pick<AccountAuthStatus, "signedIn" | "source"> &
  Partial<Pick<AccountAuthStatus, "userId">> & {
    sessionReadState: AccountSessionReadState;
  };

type PublishedRelayEndpoint = Extract<AdeAccountMachineEndpoint, { kind: "relay" }>;

function relayEndpoints(
  registration: AccountMachineRegistration,
): PublishedRelayEndpoint[] {
  return registration.reachableEndpoints.filter(
    (endpoint): endpoint is PublishedRelayEndpoint => endpoint.kind === "relay",
  );
}

function withRetainedRelayEndpoints(
  registration: AccountMachineRegistration,
  retained: readonly PublishedRelayEndpoint[],
): AccountMachineRegistration {
  if (retained.length === 0 || relayEndpoints(registration).length > 0) {
    return registration;
  }
  const reachableEndpoints = [...registration.reachableEndpoints];
  const seen = new Set(reachableEndpoints.map((endpoint) => JSON.stringify(endpoint)));
  for (const endpoint of retained) {
    const key = JSON.stringify(endpoint);
    if (seen.has(key)) continue;
    seen.add(key);
    reachableEndpoints.push(endpoint);
  }
  return { ...registration, reachableEndpoints };
}

function isPublisherSignedOut(
  status: PublisherAccountStatus | null,
): boolean {
  return status !== null
    && !status.signedIn
    && status.source !== "env-token";
}

function validatedRelayUrl(raw: string, machineKey: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "wss:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.endsWith(`/connect/${machineKey}`)
  ) {
    return null;
  }
  return url.toString();
}

export function publishedMachineName(
  name: string,
  packageChannel: string | null | undefined,
): string {
  const normalizedName = name.trim();
  const channel = packageChannel?.trim().toLowerCase();
  const suffix = channel === "beta"
    ? " · Beta"
    : channel === "alpha"
      ? " · Alpha"
      : "";
  return suffix && !normalizedName.endsWith(suffix)
    ? `${normalizedName}${suffix}`
    : normalizedName;
}

export function buildAccountMachineRegistration(args: {
  machineKey: string;
  snapshot: AccountMachineRegistrationSnapshot;
  packageChannel?: string | null;
}): AccountMachineRegistration | null {
  const machineKey = args.machineKey.trim();
  const connectInfo = args.snapshot.pairingConnectInfo;
  const isHost = args.snapshot.runtimeRole
    ? args.snapshot.runtimeRole === "host"
    : args.snapshot.role === "brain";
  if (!machineKey || !connectInfo || !isHost) {
    return null;
  }

  const endpoints: AdeAccountMachineEndpoint[] = [];
  const seen = new Set<string>();
  const add = (endpoint: AdeAccountMachineEndpoint): void => {
    const key = JSON.stringify(endpoint);
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(endpoint);
  };

  for (const candidate of connectInfo.addressCandidates) {
    const host = candidate.host.trim();
    if (!host) continue;
    if (
      candidate.kind === "lan"
      && args.snapshot.routeHealth.listener.loopbackAdeValidated
    ) {
      add({ kind: "lan", host, port: connectInfo.port });
      continue;
    }
    if (
      candidate.kind === "tailscale"
      && args.snapshot.routeHealth.tailscale.tailscaleReachable
    ) {
      add({ kind: "tailnet", host, port: connectInfo.port });
      continue;
    }
    if (
      candidate.kind === "relay"
      && args.snapshot.routeHealth.listener.loopbackAdeValidated
      && args.snapshot.routeHealth.relay.relayControlConnected
      && args.snapshot.routeHealth.relay.relayBridgeValidated
      && args.snapshot.routeHealth.relay.skipReason == null
    ) {
      const url = validatedRelayUrl(host, machineKey);
      if (url) add({ kind: "relay", url });
    }
  }

  const identity = connectInfo.hostIdentity;
  return {
    machineKey,
    deviceId: identity.deviceId,
    name: publishedMachineName(
      args.snapshot.runtimeName?.trim() || identity.name,
      args.packageChannel,
    ),
    platform: identity.platform,
    deviceType: identity.deviceType,
    // Reserved for a future machine-owned key. Account pairing currently
    // proves the connecting DEVICE's DPoP key during the sync hello instead.
    pubkey: null,
    reachableEndpoints: endpoints,
  };
}

function relayPublishStateSignature(
  snapshot: AccountMachineRegistrationSnapshot,
  registration: AccountMachineRegistration,
): string {
  const reachableEndpoints = registration.reachableEndpoints
    .map((endpoint) => JSON.stringify(endpoint))
    .sort();
  return JSON.stringify({
    relayControlConnected: snapshot.routeHealth.relay.relayControlConnected,
    relayBridgeValidated: snapshot.routeHealth.relay.relayBridgeValidated,
    reachableEndpoints,
  });
}

export function createAccountMachinePublisherService(options: {
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  getAccountStatus?: () => PublisherAccountStatus;
  getSnapshot: () => Promise<AccountMachineRegistrationSnapshot | null>;
  getMachineKey: () => string;
  directoryBaseUrl?: () => string | null | undefined;
  isSyncEnabled?: () => boolean;
  subscribeToSignIn?: (listener: () => void) => (() => void);
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  relayStatePollMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  logger?: AccountMachinePublisherLogger;
}) {
  const heartbeatMs = Math.max(1_000, Math.floor(options.heartbeatMs ?? ACCOUNT_MACHINE_HEARTBEAT_MS));
  const relayStatePollMs = Math.max(
    250,
    Math.floor(options.relayStatePollMs ?? ACCOUNT_MACHINE_RELAY_STATE_POLL_MS),
  );
  const requestTimeoutMs = Math.max(250, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  const now = options.now ?? Date.now;
  let started = false;
  let disposed = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let relayStatePollTimer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;
  let triggeredPublishPending = false;
  let lastRelayPublishStateSignature: string | null = null;
  let lastPublishedRelayState: {
    machineKey: string;
    accountOwnerId: string | null;
    endpoints: PublishedRelayEndpoint[];
  } | null = null;
  let lastWarning: string | null = null;
  let transientFailureCount = 0;
  let unsubscribeSignIn: (() => void) | null = null;
  let health = createSyncAccountDirectoryHealth(
    "sync_disabled",
    "Account-directory publishing has not started.",
  );

  const observeRelayPublishState = (signature: string): boolean => {
    const changed = lastRelayPublishStateSignature !== signature;
    lastRelayPublishStateSignature = signature;
    return changed;
  };

  const warnOnce = (code: string, meta: Record<string, unknown> = {}): void => {
    if (lastWarning === code) return;
    lastWarning = code;
    options.logger?.warn("account.machine_publish_failed", { code, ...meta });
  };

  const recordTransientFailure = (): void => {
    transientFailureCount = Math.min(
      transientFailureCount + 1,
      ACCOUNT_MACHINE_RETRY_BACKOFF_MS.length,
    );
  };

  const resetPublishCadence = (): void => {
    transientFailureCount = 0;
  };

  const clearRetainedRelayState = (): void => {
    lastPublishedRelayState = null;
  };

  const reconcileRetainedRelayOwner = (
    status: PublisherAccountStatus | null,
  ): string | null => {
    if (isPublisherSignedOut(status)) {
      clearRetainedRelayState();
      return null;
    }
    const accountOwnerId = status?.signedIn
      ? status.userId?.trim() || null
      : null;
    if (
      lastPublishedRelayState
      && lastPublishedRelayState.accountOwnerId !== accountOwnerId
      // A missing owner is tolerated only when BOTH observations lack one. The
      // brain publisher supplies userId, while small embedded/test publishers
      // may intentionally omit account identity.
      && (lastPublishedRelayState.accountOwnerId !== null || accountOwnerId !== null)
    ) {
      clearRetainedRelayState();
    }
    return accountOwnerId;
  };

  const recordOutcome = (
    state: SyncAccountDirectoryHealth["state"],
    args: {
      attemptAt: number;
      skipReason: string | null;
      directoryOrigin: string | null;
      lastHttpStatus?: number | null;
      lastHttpReason?: string | null;
      reachableEndpointCount?: number;
      succeededAt?: number;
    },
  ): void => {
    health = {
      state,
      skipReason: args.skipReason,
      directoryOrigin: args.directoryOrigin,
      lastAttemptAt: args.attemptAt,
      lastSuccessAt: args.succeededAt ?? health.lastSuccessAt,
      lastHttpStatus: args.lastHttpStatus ?? null,
      lastHttpReason: args.lastHttpReason ?? null,
      reachableEndpointCount: args.reachableEndpointCount ?? 0,
    };
  };

  const publish = async (): Promise<void> => {
    if (disposed) return;
    const attemptAt = now();
    if (options.isSyncEnabled?.() === false) {
      recordOutcome("sync_disabled", {
        attemptAt,
        skipReason: "Account-directory publishing is disabled because sync is disabled.",
        directoryOrigin: null,
      });
      return;
    }

    let baseUrl: string | null = null;
    try {
      const configuredBaseUrl = options.directoryBaseUrl?.();
      let packagedSafeBaseUrl = configuredBaseUrl;
      if (shouldIgnoreDevelopmentAccountDirectoryUrl(
        configuredBaseUrl,
        process.env,
      )) {
        warnDevelopmentClerkIgnored();
        packagedSafeBaseUrl = undefined;
      }
      baseUrl = resolveTrustedAccountDirectoryBaseUrl(
        packagedSafeBaseUrl,
      );
    } catch {
      baseUrl = null;
    }
    if (!baseUrl) {
      recordOutcome("invalid_directory_url", {
        attemptAt,
        skipReason: "The configured account-directory URL is invalid or untrusted.",
        directoryOrigin: null,
      });
      warnOnce("invalid_directory_url");
      return;
    }
    const directoryOrigin = new URL(baseUrl).origin;

    let snapshot: AccountMachineRegistrationSnapshot | null;
    try {
      snapshot = await options.getSnapshot();
    } catch {
      if (disposed) return;
      recordOutcome("snapshot_failed", {
        attemptAt,
        skipReason: "The active sync snapshot could not be read.",
        directoryOrigin,
      });
      return;
    }
    if (disposed) return;
    if (!snapshot) {
      recordOutcome("no_active_sync_scope", {
        attemptAt,
        skipReason: "No active sync scope is available.",
        directoryOrigin,
      });
      return;
    }

    let machineKey = "";
    try {
      machineKey = options.getMachineKey().trim();
    } catch {
      // The typed outcome below is the public diagnostic; no identity detail is logged.
    }
    if (!machineKey) {
      recordOutcome("machine_key_unavailable", {
        attemptAt,
        skipReason: "The machine directory key is unavailable.",
        directoryOrigin,
      });
      return;
    }
    if (!snapshot.pairingConnectInfo) {
      recordOutcome("missing_pairing_connect_info", {
        attemptAt,
        skipReason: "Pairing connection information is unavailable.",
        directoryOrigin,
      });
      return;
    }
    const isHost = snapshot.runtimeRole
      ? snapshot.runtimeRole === "host"
      : snapshot.role === "brain";
    if (!isHost) {
      recordOutcome("not_host", {
        attemptAt,
        skipReason: "This runtime is not the active sync host.",
        directoryOrigin,
      });
      return;
    }

    const observedRegistration = buildAccountMachineRegistration({
      machineKey,
      snapshot,
      packageChannel: process.env.ADE_PACKAGE_CHANNEL,
    });
    if (!observedRegistration) {
      recordOutcome("machine_key_unavailable", {
        attemptAt,
        skipReason: "The machine registration could not be built.",
        directoryOrigin,
      });
      return;
    }
    observeRelayPublishState(relayPublishStateSignature(snapshot, observedRegistration));
    const observedReachableEndpointCount = observedRegistration.reachableEndpoints.length;

    let accountStatus: PublisherAccountStatus | null = null;
    try {
      accountStatus = options.getAccountStatus?.() ?? null;
    } catch {
      recordOutcome("token_unreadable", {
        attemptAt,
        skipReason: "The ADE brain could not read account status.",
        directoryOrigin,
        reachableEndpointCount: observedReachableEndpointCount,
      });
      return;
    }
    if (isPublisherSignedOut(accountStatus)) {
      clearRetainedRelayState();
      const unreadable = accountStatus?.sessionReadState === "unreadable";
      recordOutcome(unreadable ? "token_unreadable" : "account_signed_out", {
        attemptAt,
        skipReason: unreadable
          ? "The ADE brain could not read the stored account session."
          : "The ADE brain is signed out of the ADE account.",
        directoryOrigin,
        reachableEndpointCount: observedReachableEndpointCount,
      });
      return;
    }
    const accountOwnerId = reconcileRetainedRelayOwner(accountStatus);

    // Relay readiness is sampled from multiple independently asynchronous
    // components (control socket, local bridge validation, listener handoff).
    // A momentary false sample must not overwrite the directory's last verified
    // Relay route and strand every browser/mobile client. Retain only a route
    // that THIS publisher successfully registered, for the same machine and
    // account owner, while Relay remains enabled. Explicit sign-out, owner
    // change, terminal auth rejection, or a genuinely disabled Relay clears the
    // retention boundary. The process-local compatibility path below retains
    // only a route this publisher successfully registered.
    const relayTemporarilyUnavailable = snapshot.routeHealth.relay.enabled === true
      && relayEndpoints(observedRegistration).length === 0;
    const canRetainRelay = relayTemporarilyUnavailable
      && lastPublishedRelayState?.machineKey === machineKey
      && lastPublishedRelayState.accountOwnerId === accountOwnerId;
    const registrationWithRetainedRelay = canRetainRelay
      ? withRetainedRelayEndpoints(
          observedRegistration,
          lastPublishedRelayState?.endpoints ?? [],
        )
      : observedRegistration;
    // The server-side retention hint protects the same invariant across brain
    // restarts, where this process-local compatibility cache is necessarily
    // empty. Older directory deployments safely ignore the extra property and
    // still benefit from the process-local retained route above.
    const registration: AccountMachineRegistration = relayTemporarilyUnavailable
      ? { ...registrationWithRetainedRelay, retainRelayEndpoints: true }
      : registrationWithRetainedRelay;
    const reachableEndpointCount = registration.reachableEndpoints.length;

    let accessToken: string | null = null;
    try {
      accessToken = (await options.getAccessToken())?.trim() || null;
    } catch {
      accessToken = null;
    }
    if (disposed) return;
    if (!accessToken) {
      recordOutcome("token_unreadable", {
        attemptAt,
        skipReason: "The ADE brain could not read or refresh the account token.",
        directoryOrigin,
        reachableEndpointCount,
      });
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const sendRegistration = (token: string): Promise<Response> =>
        (options.fetchImpl ?? fetch)(`${baseUrl}/account/machines/register`, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(registration),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });

      let response = await sendRegistration(accessToken);
      let firstUnauthorizedReason: string | null = null;
      if (response.status === 401) {
        firstUnauthorizedReason = await readAccountDirectoryHttpReason(response).catch(() => null);
        let refreshedToken: string | null = null;
        try {
          refreshedToken = (await options.getAccessToken({ forceRefresh: true }))?.trim() || null;
        } catch {
          // Preserve the first unauthorized response and its parsed reason.
        }
        if (disposed) return;
        if (refreshedToken) response = await sendRegistration(refreshedToken);
      }
      if (!response.ok) {
        // Always drain the final response, even when the first 401 already
        // supplied the user-facing reason. Leaving a replacement 401 body
        // unread can prevent the HTTP connection from being reused.
        const responseReason = await readAccountDirectoryHttpReason(response).catch(() => null);
        const httpReason = response.status === 401 && firstUnauthorizedReason
          ? firstUnauthorizedReason
          : responseReason;
        if (response.status >= 500) recordTransientFailure();
        else resetPublishCadence();
        if (response.status === 401 || response.status === 403) {
          clearRetainedRelayState();
        }
        recordOutcome("http_error", {
          attemptAt,
          skipReason: httpReason
            ? `The account directory returned HTTP ${response.status}: ${httpReason}`
            : `The account directory returned HTTP ${response.status}.`,
          directoryOrigin,
          lastHttpStatus: response.status,
          lastHttpReason: httpReason,
          reachableEndpointCount,
        });
        warnOnce("http_error", { status: response.status });
        return;
      }
      await response.body?.cancel().catch(() => {});
      lastWarning = null;
      resetPublishCadence();
      const publishedRelayEndpoints = relayEndpoints(registration);
      lastPublishedRelayState = publishedRelayEndpoints.length > 0
        ? {
            machineKey,
            accountOwnerId,
            endpoints: publishedRelayEndpoints,
          }
        : null;
      recordOutcome("published", {
        attemptAt,
        skipReason: null,
        directoryOrigin,
        lastHttpStatus: response.status,
        reachableEndpointCount,
        succeededAt: now(),
      });
    } catch (error) {
      if (disposed && controller.signal.aborted) return;
      const state = controller.signal.aborted ? "timeout" : "transport_error";
      recordTransientFailure();
      recordOutcome(state, {
        attemptAt,
        skipReason: state === "timeout"
          ? "The account-directory publish request timed out."
          : "The account-directory publish request could not reach the service.",
        directoryOrigin,
        reachableEndpointCount,
      });
      warnOnce(state, {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  };

  const publishNow = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    const current = publish()
      .catch((error) => {
        const attemptAt = now();
        recordOutcome("transport_error", {
          attemptAt,
          skipReason: "The account-directory publisher failed unexpectedly.",
          directoryOrigin: health.directoryOrigin,
          reachableEndpointCount: health.reachableEndpointCount,
        });
        warnOnce("transport_error", {
          errorKind: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        if (inFlight === current) inFlight = null;
      });
    inFlight = current;
    return current;
  };

  const clearHeartbeatTimer = (): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  const schedule = (): void => {
    if (!started || disposed || heartbeatTimer) return;
    const retryDelay = transientFailureCount > 0
      ? ACCOUNT_MACHINE_RETRY_BACKOFF_MS[
          Math.min(transientFailureCount, ACCOUNT_MACHINE_RETRY_BACKOFF_MS.length) - 1
        ]
      : heartbeatMs;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      void publishNow().finally(schedule);
    }, retryDelay);
    heartbeatTimer.unref?.();
  };

  const requestTriggeredPublish = (): void => {
    // A relay-state write becomes the new heartbeat anchor, avoiding a second
    // directory write when the old 30-second deadline arrives.
    clearHeartbeatTimer();
    if (triggeredPublishPending) return;
    triggeredPublishPending = true;
    const current = inFlight;
    const run = (): void => {
      triggeredPublishPending = false;
      if (disposed) return;
      clearHeartbeatTimer();
      void publishNow().finally(() => {
        clearHeartbeatTimer();
        schedule();
      });
    };
    if (current) void current.then(run, run);
    else run();
  };

  const inspectRelayPublishState = async (): Promise<void> => {
    if (!started || disposed || options.isSyncEnabled?.() === false) return;
    try {
      const accountStatus = options.getAccountStatus?.() ?? null;
      if (isPublisherSignedOut(accountStatus)) {
        clearRetainedRelayState();
        return;
      }
      reconcileRetainedRelayOwner(accountStatus);
    } catch {
      return;
    }

    let snapshot: AccountMachineRegistrationSnapshot | null;
    try {
      snapshot = await options.getSnapshot();
    } catch {
      return;
    }
    if (disposed || !snapshot) return;

    let machineKey = "";
    try {
      machineKey = options.getMachineKey().trim();
    } catch {
      return;
    }
    if (!machineKey) return;
    const registration = buildAccountMachineRegistration({
      machineKey,
      snapshot,
      packageChannel: process.env.ADE_PACKAGE_CHANNEL,
    });
    if (!registration) return;

    const signature = relayPublishStateSignature(snapshot, registration);
    // A first valid observation also publishes: startup may have run before an
    // active sync scope existed, and waiting for the heartbeat would re-create
    // the directory's 30-second connected-machine delay.
    if (observeRelayPublishState(signature)) {
      requestTriggeredPublish();
    }
  };

  const scheduleRelayStatePoll = (): void => {
    if (!started || disposed || relayStatePollTimer) return;
    relayStatePollTimer = setTimeout(() => {
      relayStatePollTimer = null;
      // The 2-second observation window also debounces/coalesces rapid tunnel
      // readiness changes without coupling this publisher to the tunnel client.
      void inspectRelayPublishState().finally(scheduleRelayStatePoll);
    }, relayStatePollMs);
    relayStatePollTimer.unref?.();
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      unsubscribeSignIn = options.subscribeToSignIn?.(() => {
        // If sign-in races an older signed-out attempt, run once more after it
        // settles instead of coalescing away the auth transition for 30s.
        requestTriggeredPublish();
      }) ?? null;
      void publishNow().finally(schedule);
      scheduleRelayStatePoll();
    },

    publishNow,

    requestPublishAfterCurrentAttempt(): void {
      requestTriggeredPublish();
    },

    getPublisherHealth(): SyncAccountDirectoryHealth {
      return { ...health };
    },

    dispose(): void {
      disposed = true;
      started = false;
      clearRetainedRelayState();
      clearHeartbeatTimer();
      if (relayStatePollTimer) clearTimeout(relayStatePollTimer);
      relayStatePollTimer = null;
      activeController?.abort();
      activeController = null;
      unsubscribeSignIn?.();
      unsubscribeSignIn = null;
    },
  };
}

export type AccountMachinePublisherService = ReturnType<
  typeof createAccountMachinePublisherService
>;

/**
 * Brain-level composition seam. Keeps account credential resolution out of the
 * already-large CLI coordinator while preserving one publisher per brain.
 */
export function createBrainAccountMachinePublisherService(options: {
  secretsDir: string;
  projectRoots: () => Iterable<string>;
  isSyncEnabled: () => boolean;
  getSnapshot: () => Promise<AccountMachineRegistrationSnapshot | null>;
  getMachineKey: () => string;
  directoryBaseUrl?: () => string | null | undefined;
  logger: BrainAccountMachinePublisherLogger;
}): AccountMachinePublisherService {
  const accountAuthService = getSharedAccountAuthService({
    secretsDir: options.secretsDir,
    projectRoots: options.projectRoots,
    logger: options.logger,
  });
  return createAccountMachinePublisherService({
    getAccessToken: (tokenOptions) => getSignedInAccountAccessToken(
      accountAuthService,
      tokenOptions,
    ),
    getAccountStatus: () => {
      const status = accountAuthService.getStatus();
      return {
        signedIn: status.signedIn,
        userId: status.userId,
        source: status.source ?? null,
        sessionReadState: accountAuthService.getSessionReadState(),
      };
    },
    isSyncEnabled: options.isSyncEnabled,
    getSnapshot: options.getSnapshot,
    getMachineKey: options.getMachineKey,
    directoryBaseUrl: () => {
      const explicit = options.directoryBaseUrl?.();
      if (explicit?.trim()) {
        if (!shouldIgnoreDevelopmentAccountDirectoryUrl(explicit, process.env)) {
          return explicit;
        }
        warnDevelopmentClerkIgnored();
      }
      return resolveOfficialAccountDirectoryBaseUrl({
        env: process.env,
        projectRoots: options.projectRoots(),
      });
    },
    subscribeToSignIn: (listener) => accountAuthService.onSignedIn(listener),
    logger: options.logger,
  });
}
