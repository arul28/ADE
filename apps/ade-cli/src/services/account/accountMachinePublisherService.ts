import path from "node:path";
import {
  createSyncAccountDirectoryHealth,
  type AdeAccountMachineEndpoint,
  type SyncAccountDirectoryHealth,
  type SyncAccountDirectoryLegDurations,
  type SyncRoleSnapshot,
  type SyncRouteHealth,
} from "../../../../desktop/src/shared/types";
import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";
import {
  createAccountDirectoryCorrelationId,
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
import {
  createMachineIdentitySigningStore,
  MACHINE_IDENTITY_SIGNING_FILE_NAME,
} from "../sync/machineIdentitySigningStore";

export const ACCOUNT_MACHINE_HEARTBEAT_MS = 30_000;
export const ACCOUNT_MACHINE_RELAY_STATE_POLL_MS = 2_000;
// Keep outage recovery comfortably inside the directory's 90-second online
// window while bounding sustained failures at a 20-second request cadence.
export const ACCOUNT_MACHINE_RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
const BODY_READ_TIMEOUT_MS = 5_000;
const SLOW_PUBLISH_LEG_MS = 2_000;
const PUBLISH_INFO_INTERVAL = 10;
export const PUBLISH_FAILURE_ANALYTICS_THRESHOLD_MS = 120_000;

export type AccountMachineRegistration = {
  machineKey: string;
  deviceId: string;
  name: string;
  platform: string;
  deviceType: string;
  pubkey: string | null;
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
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

type BrainAccountMachinePublisherLogger = AccountMachinePublisherLogger & {
  info(message: string, meta?: Record<string, unknown>): void;
};

type AccountMachinePublishLeg =
  | "setup"
  | "snapshot"
  | "token"
  | "token_refresh_401"
  | "http";

function failureLegForState(
  state: SyncAccountDirectoryHealth["state"],
): AccountMachinePublishLeg {
  if (state === "snapshot_failed" || state === "missing_pairing_connect_info") return "snapshot";
  if (state === "token_unreadable" || state === "token_timeout") return "token";
  if (
    state === "http_error"
    || state === "http_timeout"
    || state === "timeout"
    || state === "transport_error"
  ) return "http";
  return "setup";
}

class AccountMachinePublishLegTimeoutError extends Error {
  constructor(readonly leg: Extract<AccountMachinePublishLeg, "token" | "token_refresh_401" | "http">) {
    super(`Account machine publish ${leg} timed out.`);
    this.name = "AccountMachinePublishLegTimeoutError";
  }
}

function emptyLegDurations(): SyncAccountDirectoryLegDurations {
  return {
    snapshot: null,
    token: null,
    http: null,
  };
}

export type AccountMachineRegistrationSnapshot = Pick<
  SyncRoleSnapshot,
  "role" | "runtimeRole" | "runtimeName" | "pairingConnectInfo"
> & {
  routeHealth: Pick<SyncRouteHealth, "listener" | "tailscale"> & {
    relay: SyncRouteHealth["relay"] & {
      relayEndToEndVerifiedAt?: string | null;
      relayEndToEndFailure?: string | null;
      relayEndToEndRoundTripMs?: number | null;
    };
  };
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
  publicKeyRawBase64?: string | null;
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
      && Boolean(args.snapshot.routeHealth.relay.relayEndToEndVerifiedAt)
      && args.snapshot.routeHealth.relay.relayEndToEndFailure == null
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
    pubkey: args.publicKeyRawBase64?.trim()
      ? `ed25519:${args.publicKeyRawBase64.trim()}`
      : null,
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
    relayEndToEndVerifiedAt: snapshot.routeHealth.relay.relayEndToEndVerifiedAt ?? null,
    relayEndToEndFailure: snapshot.routeHealth.relay.relayEndToEndFailure ?? null,
    pubkey: registration.pubkey,
    reachableEndpoints,
  });
}

export function createAccountMachinePublisherService(options: {
  getAccessToken: (options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<string | null>;
  getAccountStatus?: () => PublisherAccountStatus;
  getSnapshot: () => Promise<AccountMachineRegistrationSnapshot | null>;
  getMachineKey: () => string;
  getMachineIdentitySigningPublicKey?: () => string;
  directoryBaseUrl?: () => string | null | undefined;
  isSyncEnabled?: () => boolean;
  subscribeToSignIn?: (listener: () => void) => (() => void);
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  relayStatePollMs?: number;
  requestTimeoutMs?: number;
  tokenTimeoutMs?: number;
  now?: () => number;
  logger?: AccountMachinePublisherLogger;
  captureAnalytics?: (input: ProductAnalyticsCapture) => void;
}) {
  const heartbeatMs = Math.max(1_000, Math.floor(options.heartbeatMs ?? ACCOUNT_MACHINE_HEARTBEAT_MS));
  const relayStatePollMs = Math.max(
    250,
    Math.floor(options.relayStatePollMs ?? ACCOUNT_MACHINE_RELAY_STATE_POLL_MS),
  );
  const requestTimeoutMs = Math.max(250, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  const tokenTimeoutMs = Math.max(250, Math.floor(options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS));
  const now = options.now ?? Date.now;
  let started = false;
  let disposed = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let relayStatePollTimer: ReturnType<typeof setTimeout> | null = null;
  const activeControllers = new Set<AbortController>();
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
  let successfulPublishCount = 0;
  let publishFailureAnalyticsEmitted = false;
  let unsubscribeSignIn: (() => void) | null = null;
  let health = createSyncAccountDirectoryHealth(
    "sync_disabled",
    "Account-directory publishing has not started.",
  );

  const readSigningPublicKey = (): string | null => {
    try {
      return options.getMachineIdentitySigningPublicKey?.().trim() || null;
    } catch {
      return null;
    }
  };

  const observeRelayPublishState = (signature: string): boolean => {
    const changed = lastRelayPublishStateSignature !== signature;
    lastRelayPublishStateSignature = signature;
    return changed;
  };

  const warnOnce = (
    code: string,
    leg: AccountMachinePublishLeg,
    legDurationsMs: SyncAccountDirectoryLegDurations,
    meta: Record<string, unknown> = {},
  ): void => {
    if (lastWarning === code) return;
    lastWarning = code;
    options.logger?.warn("account.machine_publish_failed", {
      leg,
      legDurationsMs,
      code,
      ...meta,
    });
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
      legDurations?: SyncAccountDirectoryLegDurations;
    },
  ): void => {
    const failureStates = new Set<SyncAccountDirectoryHealth["state"]>([
      "snapshot_failed",
      "machine_key_unavailable",
      "missing_pairing_connect_info",
      "token_unreadable",
      "invalid_directory_url",
      "http_error",
      "token_timeout",
      "http_timeout",
      "timeout",
      "transport_error",
    ]);
    health = {
      state,
      skipReason: args.skipReason,
      directoryOrigin: args.directoryOrigin,
      lastAttemptAt: args.attemptAt,
      lastSuccessAt: args.succeededAt ?? health.lastSuccessAt,
      lastHttpStatus: args.lastHttpStatus ?? null,
      lastHttpReason: args.lastHttpReason ?? null,
      reachableEndpointCount: args.reachableEndpointCount ?? 0,
      lastLegDurations: args.legDurations
        ? { ...args.legDurations }
        : health.lastLegDurations,
      failingSinceMs: state === "published"
        ? null
        : failureStates.has(state)
          ? health.failingSinceMs ?? args.attemptAt
          : null,
    };
    if (health.failingSinceMs == null) {
      publishFailureAnalyticsEmitted = false;
    } else if (
      !publishFailureAnalyticsEmitted
      && args.attemptAt - health.failingSinceMs >= PUBLISH_FAILURE_ANALYTICS_THRESHOLD_MS
    ) {
      publishFailureAnalyticsEmitted = true;
      const leg = failureLegForState(state);
      options.captureAnalytics?.({
        event: "ade_publish_failing",
        surface: "api",
        properties: {
          failing_minutes: Math.max(2, Math.floor((args.attemptAt - health.failingSinceMs) / 60_000)),
          leg,
          code: state,
        },
        dedupeKey: `publish-failing:${health.failingSinceMs}`,
        minimumIntervalMs: 24 * 60 * 60 * 1_000,
      });
    }
  };

  const publish = async (): Promise<void> => {
    if (disposed) return;
    const attemptAt = now();
    const legDurations = emptyLegDurations();
    const addLegDuration = (
      leg: keyof SyncAccountDirectoryLegDurations,
      startedAt: number,
    ): void => {
      const elapsed = Math.max(0, Math.round(now() - startedAt));
      legDurations[leg] = (legDurations[leg] ?? 0) + elapsed;
    };
    const outcome = (
      state: SyncAccountDirectoryHealth["state"],
      args: Omit<Parameters<typeof recordOutcome>[1], "legDurations">,
    ): void => {
      recordOutcome(state, {
        ...args,
        legDurations,
      });
    };
    const runTokenLeg = async (
      leg: Extract<AccountMachinePublishLeg, "token" | "token_refresh_401">,
      forceRefresh: boolean,
    ): Promise<string | null> => {
      const controller = new AbortController();
      activeControllers.add(controller);
      const startedAt = now();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let rejectOnAbort: (() => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new DOMException("The account token request was aborted.", "AbortError"),
        );
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        timeout = setTimeout(() => {
          controller.abort(new AccountMachinePublishLegTimeoutError(leg));
        }, tokenTimeoutMs);
        timeout.unref?.();
      });
      try {
        return await Promise.race([
          options.getAccessToken({
            ...(forceRefresh ? { forceRefresh: true } : {}),
            signal: controller.signal,
            timeoutMs: tokenTimeoutMs,
          }),
          aborted,
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (rejectOnAbort) {
          controller.signal.removeEventListener("abort", rejectOnAbort);
        }
        activeControllers.delete(controller);
        addLegDuration("token", startedAt);
      }
    };
    const correlationId = createAccountDirectoryCorrelationId();
    const sendRegistration = async (
      token: string,
      registration: AccountMachineRegistration,
      baseUrl: string,
    ): Promise<Response> => {
      const remainingHttpBudgetMs = requestTimeoutMs - (legDurations.http ?? 0);
      if (remainingHttpBudgetMs <= 0) {
        throw new AccountMachinePublishLegTimeoutError("http");
      }
      const controller = new AbortController();
      activeControllers.add(controller);
      const startedAt = now();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let rejectOnAbort: (() => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = () => reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new DOMException("The account-directory request was aborted.", "AbortError"),
        );
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        timeout = setTimeout(() => {
          controller.abort(new AccountMachinePublishLegTimeoutError("http"));
        }, remainingHttpBudgetMs);
        timeout.unref?.();
      });
      try {
        return await Promise.race([
          (options.fetchImpl ?? fetch)(`${baseUrl}/account/machines/register`, {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-ade-correlation-id": correlationId,
            },
            body: JSON.stringify(registration),
            credentials: "omit",
            referrerPolicy: "no-referrer",
            cache: "no-store",
            redirect: "error",
            signal: controller.signal,
          }),
          aborted,
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (rejectOnAbort) {
          controller.signal.removeEventListener("abort", rejectOnAbort);
        }
        activeControllers.delete(controller);
        addLegDuration("http", startedAt);
      }
    };

    if (options.isSyncEnabled?.() === false) {
      outcome("sync_disabled", {
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
      outcome("invalid_directory_url", {
        attemptAt,
        skipReason: "The configured account-directory URL is invalid or untrusted.",
        directoryOrigin: null,
      });
      warnOnce("invalid_directory_url", "setup", legDurations);
      return;
    }
    const directoryOrigin = new URL(baseUrl).origin;

    let snapshot: AccountMachineRegistrationSnapshot | null;
    const snapshotStartedAt = now();
    try {
      snapshot = await options.getSnapshot();
    } catch {
      if (disposed) return;
      outcome("snapshot_failed", {
        attemptAt,
        skipReason: "The active sync snapshot could not be read.",
        directoryOrigin,
      });
      return;
    } finally {
      addLegDuration("snapshot", snapshotStartedAt);
    }
    if (disposed) return;
    if (!snapshot) {
      outcome("no_active_sync_scope", {
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
      outcome("machine_key_unavailable", {
        attemptAt,
        skipReason: "The machine directory key is unavailable.",
        directoryOrigin,
      });
      return;
    }
    if (!snapshot.pairingConnectInfo) {
      outcome("missing_pairing_connect_info", {
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
      outcome("not_host", {
        attemptAt,
        skipReason: "This runtime is not the active sync host.",
        directoryOrigin,
      });
      return;
    }

    const publicKeyRawBase64 = readSigningPublicKey();
    if (options.getMachineIdentitySigningPublicKey && !publicKeyRawBase64) {
      outcome("machine_key_unavailable", {
        attemptAt,
        skipReason: "The machine identity signing key is unavailable.",
        directoryOrigin,
      });
      return;
    }
    const observedRegistration = buildAccountMachineRegistration({
      machineKey,
      snapshot,
      packageChannel: process.env.ADE_PACKAGE_CHANNEL,
      publicKeyRawBase64,
    });
    if (!observedRegistration) {
      outcome("machine_key_unavailable", {
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
      outcome("token_unreadable", {
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
      outcome(unreadable ? "token_unreadable" : "account_signed_out", {
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
    const relayVerificationFailed = Boolean(
      snapshot.routeHealth.relay.relayEndToEndFailure,
    );
    const canRetainRelay = relayTemporarilyUnavailable
      && !relayVerificationFailed
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
      && !relayVerificationFailed
      ? { ...registrationWithRetainedRelay, retainRelayEndpoints: true }
      : registrationWithRetainedRelay;
    const reachableEndpointCount = registration.reachableEndpoints.length;

    let accessToken: string | null = null;
    try {
      accessToken = (await runTokenLeg("token", false))?.trim() || null;
    } catch (error) {
      if (disposed) return;
      if (error instanceof AccountMachinePublishLegTimeoutError) {
        recordTransientFailure();
        outcome("token_timeout", {
          attemptAt,
          skipReason: "The ADE account token refresh timed out.",
          directoryOrigin,
          reachableEndpointCount,
        });
        warnOnce("token_timeout", "token", legDurations);
        return;
      }
      accessToken = null;
    }
    if (disposed) return;
    if (!accessToken) {
      outcome("token_unreadable", {
        attemptAt,
        skipReason: "The ADE brain could not read or refresh the account token.",
        directoryOrigin,
        reachableEndpointCount,
      });
      return;
    }

    // The request timer is cleared once headers arrive, so a stalled BODY
    // would otherwise pin the inFlight promise forever and silently stop the
    // heartbeat. Bound every body read and cancel the stream on expiry.
    const readHttpReasonBounded = async (response: Response): Promise<string | null> => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const expiry = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          void response.body?.cancel().catch(() => {});
          resolve(null);
        }, BODY_READ_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          readAccountDirectoryHttpReason(response).catch(() => null),
          expiry,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      let response = await sendRegistration(accessToken, registration, baseUrl);
      let firstUnauthorizedReason: string | null = null;
      if (response.status === 401) {
        firstUnauthorizedReason = await readHttpReasonBounded(response);
        let refreshedToken: string | null = null;
        try {
          refreshedToken = (await runTokenLeg("token_refresh_401", true))?.trim() || null;
        } catch (error) {
          if (disposed) return;
          if (error instanceof AccountMachinePublishLegTimeoutError) {
            recordTransientFailure();
            outcome("token_timeout", {
              attemptAt,
              skipReason: "The ADE account token refresh after HTTP 401 timed out.",
              directoryOrigin,
              lastHttpStatus: 401,
              lastHttpReason: firstUnauthorizedReason,
              reachableEndpointCount,
            });
            warnOnce(
              "token_timeout",
              "token_refresh_401",
              legDurations,
              { status: 401 },
            );
            return;
          }
          // Preserve the first unauthorized response and its parsed reason.
        }
        if (disposed) return;
        if (refreshedToken) {
          response = await sendRegistration(refreshedToken, registration, baseUrl);
        }
      }
      if (!response.ok) {
        // Always drain the final response, even when the first 401 already
        // supplied the user-facing reason. Leaving a replacement 401 body
        // unread can prevent the HTTP connection from being reused.
        const responseReason = await readHttpReasonBounded(response);
        const httpReason = response.status === 401 && firstUnauthorizedReason
          ? firstUnauthorizedReason
          : responseReason;
        if (response.status >= 500) recordTransientFailure();
        else resetPublishCadence();
        if (response.status === 401 || response.status === 403) {
          clearRetainedRelayState();
        }
        outcome("http_error", {
          attemptAt,
          skipReason: httpReason
            ? `The account directory returned HTTP ${response.status}: ${httpReason}`
            : `The account directory returned HTTP ${response.status}.`,
          directoryOrigin,
          lastHttpStatus: response.status,
          lastHttpReason: httpReason,
          reachableEndpointCount,
        });
        warnOnce("http_error", "http", legDurations, { status: response.status });
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
      outcome("published", {
        attemptAt,
        skipReason: null,
        directoryOrigin,
        lastHttpStatus: response.status,
        reachableEndpointCount,
        succeededAt: now(),
      });
      successfulPublishCount += 1;
      const logMeta = { legDurationsMs: { ...legDurations } };
      const slow = Object.values(legDurations).some(
        (duration) => duration != null && duration > SLOW_PUBLISH_LEG_MS,
      );
      if (slow) {
        options.logger?.warn("account.machine_publish_ok", logMeta);
      } else if (successfulPublishCount % PUBLISH_INFO_INTERVAL === 0) {
        options.logger?.info?.("account.machine_publish_ok", logMeta);
      } else {
        options.logger?.debug?.("account.machine_publish_ok", logMeta);
      }
    } catch (error) {
      if (disposed) return;
      const isHttpTimeout = error instanceof AccountMachinePublishLegTimeoutError
        && error.leg === "http";
      const state = isHttpTimeout ? "http_timeout" : "transport_error";
      recordTransientFailure();
      outcome(state, {
        attemptAt,
        skipReason: state === "http_timeout"
          ? "The account-directory publish request timed out."
          : "The account-directory publish request could not reach the service.",
        directoryOrigin,
        reachableEndpointCount,
      });
      warnOnce(state, "http", legDurations, {
        errorKind: error instanceof Error ? error.name : "unknown",
      });
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
        warnOnce("transport_error", "setup", health.lastLegDurations, {
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
    const publicKeyRawBase64 = readSigningPublicKey();
    if (options.getMachineIdentitySigningPublicKey && !publicKeyRawBase64) return;
    const registration = buildAccountMachineRegistration({
      machineKey,
      snapshot,
      packageChannel: process.env.ADE_PACKAGE_CHANNEL,
      publicKeyRawBase64,
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
      return {
        ...health,
        lastLegDurations: { ...health.lastLegDurations },
      };
    },

    dispose(): void {
      disposed = true;
      started = false;
      clearRetainedRelayState();
      clearHeartbeatTimer();
      if (relayStatePollTimer) clearTimeout(relayStatePollTimer);
      relayStatePollTimer = null;
      for (const controller of activeControllers) {
        controller.abort(new DOMException("The account publisher was disposed.", "AbortError"));
      }
      activeControllers.clear();
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
  captureAnalytics?: (input: ProductAnalyticsCapture) => void;
}): AccountMachinePublisherService {
  const accountAuthService = getSharedAccountAuthService({
    secretsDir: options.secretsDir,
    projectRoots: options.projectRoots,
    logger: options.logger,
  });
  const signingStore = createMachineIdentitySigningStore({
    filePath: path.join(options.secretsDir, MACHINE_IDENTITY_SIGNING_FILE_NAME),
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
    getMachineIdentitySigningPublicKey: () =>
      signingStore.getOrCreate().publicKeyRawBase64,
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
    captureAnalytics: options.captureAnalytics,
  });
}
