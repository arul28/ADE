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
  type AccountSessionReadFailureReason,
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
import { createEpisodeAnalytics } from "./episodeAnalytics";

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
  /**
   * Marks a deliberate, user-initiated link of this machine to the account —
   * the only thing the directory accepts as clearing a revocation.
   *
   * NEVER set on the 30-second heartbeat. A removed machine that keeps
   * heartbeating is exactly how removal stopped being durable: the directory
   * re-inserted the row it had just deleted. A heartbeat asserts "still here",
   * which is only meaningful if the account already agrees this machine
   * belongs; re-joining is a separate, explicit act.
   */
  pairing?: true;
  /**
   * Single-use proof, minted by the directory when this machine last completed
   * an interactive sign-in it observed, that the `pairing` above is backed by a
   * human who just authenticated here.
   *
   * Sent only alongside `pairing`, and only when one is held. It is the second
   * of two independent proofs — the first being a freshly-authenticated claim
   * on the access token itself — and it exists because that claim is not in the
   * documented claim set for the OAuth access tokens ADE authenticates with.
   * Without it, an account removal could be unrecoverable rather than durable.
   */
  pairingGrant?: string;
};

/**
 * What the desktop and the CLI say when the directory refuses a re-pair for
 * want of a fresh sign-in. It has to name the action, not the status code: a
 * bare 403 tells the owner their machine is gone and nothing about the one
 * thing that brings it back.
 *
 * Worded to survive being wrapped: the desktop's reconnect banner prefixes it
 * with "Couldn't reconnect this computer:" and follows it with "It's still
 * disconnected from your account.", and `ade doctor` prints it alone.
 */
export const PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE =
  "Sign in to your ADE account again on this computer to reconnect it.";

/**
 * The directory's machine-readable answer for a refused pairing publish, taken
 * verbatim from the 403 body's `code`.
 *
 * This is the discriminator callers branch on. Both refusals surface as
 * `state: "http_error"` — they differ only in what the user can do about it —
 * so before this existed the user-facing sentence was the only thing telling
 * them apart, and a copy edit to `PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE`
 * would have silently disabled the desktop's sign-in-and-retry recovery.
 *
 * Only codes ADE actually understands are surfaced. An unrecognised code stays
 * an ordinary HTTP failure with no code rather than being guessed at, so a
 * newer directory can add refusals without an older brain mis-acting on them.
 */
export type AccountMachinePairingRefusalCode =
  | "machine_revoked"
  | "pairing_authentication_required";

/**
 * The one refusal a caller can act on: the machine is revoked and the re-pair
 * carried no fresh-authentication proof, so signing in again fixes it. Named
 * here so callers branch on the code rather than on the user-facing sentence,
 * which is copy and may be reworded.
 */
export const ACCOUNT_PAIRING_AUTHENTICATION_REQUIRED_CODE: AccountMachinePairingRefusalCode =
  "pairing_authentication_required";

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

/**
 * Outcome of a deliberate re-pair. `published` is the only field a caller may
 * treat as "the account took this machine back" — `revoked: false` alone just
 * means the local latch was lifted for the attempt.
 */
export type AccountMachinePairingResult = {
  published: boolean;
  revoked: boolean;
  state: SyncAccountDirectoryHealth["state"];
  reason: string | null;
  /**
   * Why the directory refused, machine-readable. Present only when the refusal
   * actually carried a code ADE understands; `reason` remains the sentence to
   * show a human and must not be parsed to recover this.
   */
  reasonCode?: AccountMachinePairingRefusalCode;
};

/**
 * Normalise the directory's `revokedAt` to an ISO string.
 *
 * It is a D1 integer (epoch milliseconds) on the wire, so a string-only read
 * silently reported "removed at unknown time" for every real removal. Both
 * shapes are accepted rather than only the current one: this field is purely
 * explanatory, and a format change must never be able to look like a machine
 * that was not removed.
 */
function readRevokedAt(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Run one bounded read over a response body.
 *
 * The request timer is cleared once headers arrive, so a stalled BODY would
 * otherwise pin the inFlight promise forever and silently stop the heartbeat.
 * Every body read goes through here: it races the caller's parse against a
 * deadline, cancels the stream on expiry, and always clears its timer.
 */
async function boundedBodyRead<T>(
  response: Response,
  read: (response: Response) => Promise<T | null>,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => {});
      resolve(null);
    }, BODY_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      read(response).catch(() => null),
      expiry,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Recognise the directory's two revocation answers. Shape-checked, not
 * status-only: a plain 403 from a proxy or WAF is not the account owner
 * removing this machine, and mistaking one for the other would silently
 * stop a healthy machine from ever publishing again.
 *
 * `machine_revoked` means "you were removed". `pairing_authentication_required`
 * means "you were removed AND this re-pair attempt carried no proof of a
 * fresh sign-in" — same terminal state, but a different sentence, because
 * the second one has a specific thing the user can do about it.
 */
async function readMachineRevokedBounded(response: Response): Promise<{
  code: AccountMachinePairingRefusalCode;
  revokedAt: string | null;
} | null> {
  if (response.status !== 403) return null;
  return boundedBodyRead(response, async (bounded) => {
    const body: unknown = await bounded.clone().json();
    if (!body || typeof body !== "object") return null;
    const record = body as Record<string, unknown>;
    if (
      record.code !== "machine_revoked"
      && record.code !== "pairing_authentication_required"
    ) return null;
    return { code: record.code, revokedAt: readRevokedAt(record.revokedAt) };
  });
}

function readHttpReasonBounded(response: Response): Promise<string | null> {
  return boundedBodyRead(response, readAccountDirectoryHttpReason);
}

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
    /** Which read path produced an unreadable session (analytics only). */
    sessionReadFailureReason?: AccountSessionReadFailureReason | null;
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
  /**
   * Takes the pairing grant from the last interactive sign-in the directory
   * observed, if any. Read ONLY on the deliberate pairing publish: a grant is
   * single-use server-side, so letting a heartbeat touch it would burn the
   * user's one proof on a request that has no use for it.
   */
  consumePairingGrant?: () => string | null;
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
  /**
   * Consumed by the next publish attempt, which sends `pairing: true` exactly
   * once. Held as a one-shot rather than a mode so a deliberate link can never
   * leak into the heartbeats that follow it.
   */
  let pendingPairingPublish = false;
  /**
   * Terminal: the directory answered `403 machine_revoked`. The heartbeat loop
   * stops here — the account removed this machine, and re-registering on a
   * timer is precisely what made removal non-durable. Only an explicit
   * `publishPairing()` can resume it.
   */
  let machineRevoked = false;
  let machineRevokedAt: string | null = null;
  /**
   * The directory's `code` from the most recent publish attempt, or null when
   * that attempt did not end in a recognised refusal. Reset at the top of every
   * attempt so `publishPairing()` can only ever read the code belonging to the
   * request it just made — a stale code from an earlier removal must not make a
   * transport failure look like a re-authentication prompt.
   */
  let lastPairingRefusalCode: AccountMachinePairingRefusalCode | null = null;
  let lastRelayPublishStateSignature: string | null = null;
  let lastPublishedRelayState: {
    machineKey: string;
    accountOwnerId: string | null;
    endpoints: PublishedRelayEndpoint[];
  } | null = null;
  let lastWarning: string | null = null;
  let transientFailureCount = 0;
  let successfulPublishCount = 0;
  let unsubscribeSignIn: (() => void) | null = null;
  let health = createSyncAccountDirectoryHealth(
    "sync_disabled",
    "Account-directory publishing has not started.",
  );

  const captureAnalytics = () => options.captureAnalytics;
  const publishFailureAnalytics = createEpisodeAnalytics({
    event: "ade_publish_failing",
    dedupePrefix: "publish-failing",
    capture: captureAnalytics,
  });
  const sessionUnreadableAnalytics = createEpisodeAnalytics({
    event: "ade_account_session_unreadable",
    dedupePrefix: "account-session-unreadable",
    capture: captureAnalytics,
  });

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

  /**
   * Latch the terminal removal state and stop the heartbeat. Deliberately not
   * `dispose()`: the service stays readable so callers can report the removal,
   * and `publishPairing()` can bring it back after the user re-pairs.
   */
  const enterMachineRevoked = (revokedAt: string | null): void => {
    machineRevoked = true;
    machineRevokedAt = revokedAt;
    pendingPairingPublish = false;
    clearHeartbeatTimer();
    options.logger?.warn("account.machine_revoked", { revokedAt });
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
      publishFailureAnalytics.end();
    } else if (args.attemptAt - health.failingSinceMs >= PUBLISH_FAILURE_ANALYTICS_THRESHOLD_MS) {
      publishFailureAnalytics.report({
        dedupeValue: health.failingSinceMs,
        properties: {
          failing_minutes: Math.max(2, Math.floor((args.attemptAt - health.failingSinceMs) / 60_000)),
          leg: failureLegForState(state),
          code: state,
        },
      });
    }
  };

  /**
   * Reports the "app signed in, brain cannot read the session" failure once per
   * episode, tagged with the read path that produced it.
   */
  const observeSessionReadFailure = (
    code: AccountSessionReadFailureReason | "unknown",
  ): void => {
    sessionUnreadableAnalytics.report({ dedupeValue: code, properties: { code } });
  };

  const observeSessionReadState = (status: PublisherAccountStatus | null): void => {
    if (!status || status.sessionReadState !== "unreadable") {
      sessionUnreadableAnalytics.end();
      return;
    }
    observeSessionReadFailure(status.sessionReadFailureReason ?? "unknown");
  };

  const publish = async (): Promise<void> => {
    if (disposed) return;
    // A revoked machine only publishes again as part of a deliberate re-pair.
    if (machineRevoked && !pendingPairingPublish) return;
    lastPairingRefusalCode = null;
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
      // A throwing status read is the same user-visible failure as an
      // "unreadable" one — the brain cannot obtain the session — so it belongs
      // to the same episode and reports the documented `read_error` code.
      observeSessionReadFailure("read_error");
      outcome("token_unreadable", {
        attemptAt,
        skipReason: "The ADE brain could not read account status.",
        directoryOrigin,
        reachableEndpointCount: observedReachableEndpointCount,
      });
      return;
    }
    observeSessionReadState(accountStatus);
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
    const registrationWithRelayHint: AccountMachineRegistration = relayTemporarilyUnavailable
      && !relayVerificationFailed
      ? { ...registrationWithRetainedRelay, retainRelayEndpoints: true }
      : registrationWithRetainedRelay;
    // Consume the one-shot here, not at send time: every path below this point
    // either sends the request or abandons the attempt, and a pairing intent
    // that survived a failed attempt would eventually ride a heartbeat. The
    // early returns ABOVE never reach this line, which is why `publishPairing`
    // also clears the flag once its own attempt settles.
    const isPairingPublish = pendingPairingPublish;
    pendingPairingPublish = false;
    let pairingGrant: string | null = null;
    if (isPairingPublish) {
      try {
        pairingGrant = options.consumePairingGrant?.()?.trim() || null;
      } catch {
        pairingGrant = null;
      }
    }
    const registration: AccountMachineRegistration = isPairingPublish
      ? {
        ...registrationWithRelayHint,
        pairing: true,
        ...(pairingGrant ? { pairingGrant } : {}),
      }
      : registrationWithRelayHint;
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
        // A removed machine is terminal, not transient: the directory will keep
        // answering 403 and the heartbeat that retries is the very thing that
        // used to resurrect the deleted roster row. Stop the loop and say so.
        const revocation = await readMachineRevokedBounded(response);
        if (revocation) {
          // Both codes are terminal for the heartbeat: the account still does
          // not include this machine, and retrying on a timer is what made a
          // removal non-durable. Only the sentence differs.
          enterMachineRevoked(revocation.revokedAt);
          clearRetainedRelayState();
          resetPublishCadence();
          lastPairingRefusalCode = revocation.code;
          outcome("http_error", {
            attemptAt,
            skipReason: revocation.code === "pairing_authentication_required"
              ? PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE
              : "This machine was removed from your ADE account. Pair it again to reconnect.",
            directoryOrigin,
            lastHttpStatus: response.status,
            lastHttpReason: revocation.code,
            reachableEndpointCount,
          });
          return;
        }
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
    // No heartbeat after revocation: re-registering on a timer is what made a
    // removal non-durable in the first place.
    if (!started || disposed || machineRevoked || heartbeatTimer) return;
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

    /**
     * Register this machine as a deliberate, user-initiated link — the only
     * request that carries `pairing: true` and therefore the only one the
     * directory accepts as clearing a revocation. Call it from an explicit
     * pairing action, never from a timer or a status change.
     *
     * Reports whether the directory actually accepted the re-pair, because the
     * push half of the removal may only be lifted together with this one: a
     * machine back on the roster but still push-gated is worse than one that is
     * plainly gone.
     */
    async publishPairing(): Promise<AccountMachinePairingResult> {
      if (disposed) {
        return {
          published: false,
          revoked: machineRevoked,
          state: health.state,
          reason: "The account-directory publisher is no longer running.",
        };
      }
      // The pairing request itself is what proves the machine may re-join, so
      // lift the local stop before sending; a still-revoked machine will simply
      // be told so again.
      machineRevoked = false;
      machineRevokedAt = null;
      resetPublishCadence();
      clearHeartbeatTimer();
      // An in-flight heartbeat would consume the one-shot without the pairing
      // intent (`publish` reads the flag mid-attempt, after its early returns),
      // so wait it out and only then arm the flag — that way it can only ride
      // the request this call is about to make.
      if (inFlight) await inFlight.catch(() => {});
      pendingPairingPublish = true;
      const publishesBefore = successfulPublishCount;
      await publishNow();
      // Scope the one-shot to THIS call. `publish` consumes the flag only once
      // it is past its early returns, so an attempt abandoned before that point
      // (no sync scope, no machine key, signed out, …) would otherwise leave the
      // intent armed for the very next 30-second heartbeat — which would then
      // send `pairing: true` plus the single-use grant on a request the user
      // never made, spending the grant and possibly clearing a revocation the
      // owner applied in the meantime. Clearing it here is a no-op on the
      // success path, where `publish` already consumed it.
      pendingPairingPublish = false;
      schedule();
      // Counted, not inferred from health: only a 2xx registration increments
      // it, so a pairing attempt that was skipped (no token, no snapshot) or
      // rejected can never read as accepted.
      const published = successfulPublishCount > publishesBefore;
      return {
        published,
        revoked: machineRevoked,
        state: health.state,
        reason: published
          ? null
          : health.skipReason
            ?? "The account directory did not accept this machine.",
        // Omitted rather than nulled when there is no code, so the field is
        // purely additive on the wire and an older reader sees nothing new.
        ...(published || !lastPairingRefusalCode
          ? {}
          : { reasonCode: lastPairingRefusalCode }),
      };
    },

    /** Terminal removal state, for callers that must explain the stop. */
    getMachineRevocation(): { revoked: boolean; revokedAt: string | null } {
      return { revoked: machineRevoked, revokedAt: machineRevokedAt };
    },

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
        sessionReadFailureReason: accountAuthService.getSessionReadFailureReason(),
      };
    },
    isSyncEnabled: options.isSyncEnabled,
    getSnapshot: options.getSnapshot,
    getMachineKey: options.getMachineKey,
    getMachineIdentitySigningPublicKey: () =>
      signingStore.getOrCreate().publicKeyRawBase64,
    // Same shared auth service the access token comes from, so the grant a
    // device sign-in earned in this brain reaches the publish that needs it.
    consumePairingGrant: () => accountAuthService.consumePairingGrant(),
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
