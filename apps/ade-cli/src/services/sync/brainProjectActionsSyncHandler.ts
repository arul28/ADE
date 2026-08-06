import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ProjectBrowseInput,
  PersonalChatScopeContract,
  SyncChatSubscribePayload,
  SyncChatSubscribeSnapshotPayload,
  SyncChatHistoryRequestPayload,
  SyncChatUnsubscribePayload,
  SyncCommandPayload,
  SyncApplicationCompressionCodec,
  SyncRemoteCommandDescriptor,
  SyncEnvelope,
  SyncHelloErrorPayload,
  SyncMobileProjectSummary,
  SyncPairingRequestPayload,
  SyncPairingResultPayload,
  SyncPeerMetadata,
  SyncProjectForgetRequestPayload,
  SyncProjectForgetResultPayload,
  SyncProjectCatalogPayload,
  SyncProjectOpenRequestPayload,
  SyncProjectSwitchRequestPayload,
} from "../../../../desktop/src/shared/types";
import {
  SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES,
  SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY,
} from "../../../../desktop/src/shared/types";
import { parseAgentChatTranscript } from "../../../../desktop/src/shared/chatTranscript";
import { isPersonalChatActionQueueable } from "../../../../desktop/src/shared/types/personalChats";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { nowIso } from "../../../../desktop/src/main/services/shared/utils";
import type { SharedSyncListenerConnectionHandler } from "./sharedSyncListener";
import { SYNC_HOST_BIND_LOOPBACK_ONLY } from "./sharedSyncListener";
import type { SyncCredentialStore } from "../credentials/credentialStore";
import { isValidDpopPublicKey, type SyncPairingRecord } from "./syncPairingStore";
import { resolveBrainMachineSyncStores } from "./brainMachineSyncStores";
import { createSyncDpopNonceCache, evaluatePairedHelloDpop, syncDpopFailureMessage } from "./syncDpop";
import {
  authenticateSyncAccountHello,
  SYNC_REPAIR_REQUIRED_MESSAGE,
  type SyncAccountHelloAuth,
} from "./syncAccountHelloAuth";
import {
  createPairFailureTracker,
  type PairFailureSubject,
} from "./syncPairFailureTracker";
import {
  createRelayAuthorizationLifecycle,
  SYNC_RELAY_AUTHORIZATION_CLOSE_CODE,
  type RelayAuthorizationLifecycle,
} from "./relayAuthorization";
import {
  createSyncPairedChannelService,
  isPairedRuntimeEnvelopeType,
} from "./syncPairedChannelService";
import {
  DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
  encodeSyncEnvelope,
  mapPlatform,
  negotiateSyncApplicationCompression,
  parseSyncEnvelope,
  sendSyncProtocolVersionMismatchAndClose,
  SyncProtocolVersionMismatchError,
  wsDataToText,
} from "./syncProtocol";
// The SAME parser the project sync host uses. This handler used to carry a
// narrower private copy that only understood `bootstrap` and `paired` auth, so
// a signed-in web client's `account` hello was rejected as "Invalid hello
// payload." on exactly the machines this handler exists to serve.
import {
  parseHelloPayload,
  parsePairingRequestPayload,
} from "./syncHelloProtocol";
import {
  ACCOUNT_AUTH_TRANSIENT_IDENTITY_GRACE_MS,
  buildSyncHostHelloOkPayload,
  buildSyncProjectCatalogMessages,
  isRuntimeHostPairingRecord,
  type SyncProjectCatalogProvider,
} from "./syncHostService";
import { resolveDeviceDisplayName } from "./deviceRegistryService";
import type { AccountAuthService } from "../account/accountAuthService";
import {
  getSharedAccountAttestationConfig,
  getSharedAccountAuthService,
  type AccountAttestationConfig,
} from "../account/sharedAccountAuthService";
import {
  verifyClerkAccountAttestation,
  type VerifiedAccountAttestation,
} from "../account/accountAttestationVerifier";

type BrainProjectActionsSyncHandlerArgs = {
  logger: Logger;
  projectCatalogProvider: SyncProjectCatalogProvider;
  bootstrapCredentialStore: SyncCredentialStore;
  bootstrapTokenKey?: string;
  legacyBootstrapTokenPath?: string | null;
  /**
   * Machine-level `~/.ade/secrets`. The pairing, PIN, and security stores are
   * resolved from it through `resolveBrainMachineSyncStores`, so this ingress
   * path and the brain's RPC surface mutate the SAME instances — a private
   * second set would write the right files and still be invisible here.
   */
  secretsDir: string;
  localDeviceIdPath: string;
  localSiteIdPath: string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  authTimeoutMs?: number;
  /** Mirrors SyncHostServiceArgs.getCloudRelayWssUrl for the fallback hello_ok. */
  getCloudRelayWssUrl?: () => string | null;
  accountAuthService?: Pick<AccountAuthService, "getStatus" | "getAccessToken">;
  /** `null` when this build cannot verify accounts at all — a distinct rejection. */
  getAccountAttestationConfig?: () => AccountAttestationConfig | null;
  verifyAccountAttestation?: typeof verifyClerkAccountAttestation;
  personalChatScope?: PersonalChatScopeContract;
};

type BrainPeerState = {
  ws: WebSocket;
  lifecycleGeneration: number;
  authenticated: boolean;
  authKind: "bootstrap" | "paired" | null;
  authTimeout: ReturnType<typeof setTimeout> | null;
  metadata: SyncPeerMetadata | null;
  personalChatSubscriptions: Map<string, { transcriptPath: string; offset: number }>;
  pairingRecord: SyncPairingRecord | null;
  relayAuthorization: RelayAuthorizationLifecycle | null;
  messageQueue: Promise<void>;
};

const WS_OPEN = 1;
/**
 * Exported so the credential store's migration-exclusion list can be asserted
 * against the real key instead of a bare literal: this token is read by the
 * brain straight from the shared file store, and a silent rename would move it
 * into the Electron-only safeStorage file.
 */
export const BOOTSTRAP_TOKEN_KEY = "sync.bootstrapToken.v1";
const BRAIN_SYNC_AUTH_TIMEOUT_MS = 15_000;
const brainPeerCompressionBySocket = new WeakMap<WebSocket, SyncApplicationCompressionCodec>();

function ensureSecretFile(filePath: string, bytes: number): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${randomBytes(bytes).toString("hex")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failures on platforms that do not support it
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function readLegacySecretFile(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function ensureCredentialSecret(
  store: SyncCredentialStore,
  key: string,
  bytes: number,
  legacyPath?: string | null,
): string {
  const existing = store.getSync(key)?.trim();
  if (existing) return existing;
  const next = readLegacySecretFile(legacyPath) ?? randomBytes(bytes).toString("hex");
  store.setSync(key, next);
  return next;
}

function safeStringEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    timingSafeEqual(expectedBuffer, Buffer.alloc(expectedBuffer.length));
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unavailableChatHistoryPage(
  sessionId: string,
  beforeOffset: number,
): AgentChatEventHistoryPage {
  return {
    sessionId,
    events: [],
    startOffset: beforeOffset,
    hasMore: beforeOffset > 0,
    sessionFound: false,
    unavailable: true,
  };
}

function normalizeChatHistoryPage(
  value: unknown,
  sessionId: string,
  beforeOffset: number,
): AgentChatEventHistoryPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unavailableChatHistoryPage(sessionId, beforeOffset);
  }
  const record = value as Record<string, unknown>;
  const startOffset = typeof record.startOffset === "number" && Number.isFinite(record.startOffset)
    ? Math.max(0, Math.floor(record.startOffset))
    : null;
  if (
    optionalString(record.sessionId) !== sessionId
    || !Array.isArray(record.events)
    || startOffset == null
    || startOffset > beforeOffset
    || typeof record.hasMore !== "boolean"
    || typeof record.sessionFound !== "boolean"
  ) {
    return unavailableChatHistoryPage(sessionId, beforeOffset);
  }
  return {
    sessionId,
    events: record.events as AgentChatEventEnvelope[],
    startOffset,
    hasMore: record.hasMore,
    sessionFound: record.sessionFound,
    ...(record.unavailable === true ? { unavailable: true } : {}),
  };
}

function send(
  ws: WebSocket,
  type: SyncEnvelope["type"],
  payload: unknown,
  requestId?: string | null,
): boolean {
  if (ws.readyState !== WS_OPEN) return false;
  try {
    const compressionCodec = brainPeerCompressionBySocket.get(ws) ?? null;
    ws.send(encodeSyncEnvelope({
      type,
      requestId,
      payload,
      compressionThresholdBytes: compressionCodec
        ? SYNC_APPLICATION_COMPRESSION_THRESHOLD_BYTES
        : DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
      compressionCodec: compressionCodec ?? "gzip",
    }));
    return true;
  } catch {
    return false;
  }
}

function sendProjectCatalog(
  ws: WebSocket,
  catalog: SyncProjectCatalogPayload,
  requestId?: string | null,
): void {
  for (const message of buildSyncProjectCatalogMessages({
    projectCatalog: catalog,
    requestId,
    compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
  })) {
    send(ws, message.type, message.payload, message.requestId);
  }
}

function projectActionsEnabled(provider: SyncProjectCatalogProvider): boolean {
  return Boolean(
    provider.browseDirectories
      && provider.getDefaultParentDir
      && provider.openProject
      && provider.createProject
      && provider.cloneProject
      && provider.listMyGitHubRepos,
  );
}

async function projectCatalog(provider: SyncProjectCatalogProvider, logger: Logger): Promise<SyncProjectCatalogPayload> {
  try {
    return await provider.listProjects();
  } catch (error) {
    logger.warn("sync_brain.project_catalog_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { projects: [] };
  }
}

function personalChatCommandDescriptors(
  scope: BrainProjectActionsSyncHandlerArgs["personalChatScope"],
): SyncRemoteCommandDescriptor[] {
  if (!scope) return [];
  const descriptors = scope.capabilities().actions.map((action) => ({
    action: `personalChats.${action}`,
    scope: "runtime" as const,
    policy: {
      viewerAllowed: true,
      queueable: isPersonalChatActionQueueable(action),
    },
  }));
  descriptors.push({
    action: "personalChats.streamEvents",
    scope: "runtime",
    policy: { viewerAllowed: true, queueable: false },
  });
  return descriptors;
}

async function readPersonalChatEventsSince(
  transcriptPath: string,
  offset: number,
): Promise<{ events: AgentChatEventEnvelope[]; nextOffset: number }> {
  let file: fs.promises.FileHandle | null = null;
  try {
    file = await fs.promises.open(transcriptPath, "r");
    const size = (await file.stat()).size;
    const start = Math.max(0, Math.min(offset, size));
    if (start >= size) return { events: [], nextOffset: size };
    const bytes = Buffer.alloc(size - start);
    await file.read(bytes, 0, bytes.length, start);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return { events: [], nextOffset: start };
    const complete = bytes.subarray(0, lastNewline + 1);
    return {
      events: parseAgentChatTranscript(complete.toString("utf8")),
      nextOffset: start + complete.length,
    };
  } catch {
    return { events: [], nextOffset: Math.max(0, offset) };
  } finally {
    await file?.close().catch(() => {});
  }
}

export function createBrainProjectActionsSyncHandler(
  args: BrainProjectActionsSyncHandlerArgs,
): SharedSyncListenerConnectionHandler {
  const bootstrapToken = ensureCredentialSecret(
    args.bootstrapCredentialStore,
    args.bootstrapTokenKey ?? BOOTSTRAP_TOKEN_KEY,
    24,
    args.legacyBootstrapTokenPath,
  );
  // Shared with the brain's RPC surface, so `ade sync pin generate` and the
  // desktop's `ade.sync.setPin` mutate the SAME store this ingress path
  // verifies against — `createSyncPinStore` only shows a plaintext code the
  // instance itself set.
  const { pinStore, pairingStore, securityStore } =
    resolveBrainMachineSyncStores(args.secretsDir);
  const dpopNonceCache = createSyncDpopNonceCache();
  // One in-flight account-hello commit per device, so two routes arriving
  // together cannot both write a pairing record for it.
  const accountHelloCommitLocks = new Map<string, Promise<unknown>>();
  const withAccountHelloCommitLock = async <T>(
    deviceId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const previous = accountHelloCommitLocks.get(deviceId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    // Stored settled-only so one rejected commit cannot reject every later
    // waiter chained behind it.
    const guarded = next.catch(() => {});
    accountHelloCommitLocks.set(deviceId, guarded);
    try {
      return await next;
    } finally {
      if (accountHelloCommitLocks.get(deviceId) === guarded) {
        accountHelloCommitLocks.delete(deviceId);
      }
    }
  };
  const accountSecretsDir = args.secretsDir;
  const accountAuthService = args.accountAuthService ?? getSharedAccountAuthService({
    secretsDir: accountSecretsDir,
    projectRoots: () => [],
    logger: args.logger,
  });
  const getAccountAttestationConfig = args.getAccountAttestationConfig ?? (() =>
    getSharedAccountAttestationConfig({ secretsDir: accountSecretsDir }));
  const verifyAccountAttestation = args.verifyAccountAttestation
    ?? verifyClerkAccountAttestation;
  let accountAuthorizationUserId: string | null = null;
  let accountAuthorizationGeneration = 0;
  let accountAuthorizationInitialized = false;
  let accountAuthorizationContinuityUserId: string | null = null;
  let accountAuthorizationContinuityUntilMs = 0;
  let accountAuthorizationRetainedOwnerId: string | null = null;
  /**
   * Ownership, not usability. `signedIn` answers "can this machine call the
   * account API right now"; this answers "is this still the same person's
   * machine". They differ for everything except a deliberate sign-out: an
   * expired grant or an unreadable credential store is an accident, and
   * reading one as a sign-out is what made `applyExplicitAccountUserId(null)`
   * delete every account-owned pairing on the box over a token problem. Only a
   * genuine `signed_out` — or a different user signing in — drops ownership.
   * Anything that needs a live token still gates on `signedIn` via
   * `getAccountLeaseUserId`'s token round trip.
   *
   * `ownerUnknown` covers the case retention alone cannot: a brain that BOOTS
   * with a locked keychain has never seen an owner to retain, so it knows
   * nothing rather than knowing the machine is signed out. Applying null there
   * would delete every account-owned pairing on the box because a credential
   * store was briefly unreadable.
   */
  const readExplicitAccountStatus = (): {
    userId: string | null;
    expiresAtMs: number | null;
    retained: boolean;
    ownerUnknown: boolean;
  } => {
    const status = accountAuthService.getStatus();
    const userId = status.signedIn ? status.userId?.trim() || null : null;
    const expiresAtMs = status.expiresAt ? Date.parse(status.expiresAt) : Number.NaN;
    if (userId) {
      accountAuthorizationRetainedOwnerId = userId;
      return {
        userId,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
        retained: false,
        ownerUnknown: false,
      };
    }
    const sessionState = status.sessionState;
    if (sessionState === "expired" || sessionState === "unreadable") {
      return {
        userId: accountAuthorizationRetainedOwnerId,
        expiresAtMs: null,
        retained: accountAuthorizationRetainedOwnerId != null,
        ownerUnknown: accountAuthorizationRetainedOwnerId == null,
      };
    }
    accountAuthorizationRetainedOwnerId = null;
    return { userId: null, expiresAtMs: null, retained: false, ownerUnknown: false };
  };
  const applyExplicitAccountUserId = (userId: string | null): void => {
    if (accountAuthorizationInitialized && accountAuthorizationUserId === userId) return;
    accountAuthorizationInitialized = true;
    accountAuthorizationUserId = userId;
    accountAuthorizationGeneration += 1;
    accountAuthorizationContinuityUserId = null;
    accountAuthorizationContinuityUntilMs = 0;
    pairingStore.revokeAccountOwnedExcept(userId);
  };
  /**
   * Apply a lease read, unless the read said nothing. No information is not a
   * sign-out — only a real `signed_out` state revokes account-owned trust.
   */
  const applyExplicitAccountUserIdFromStatus = (
    status: { userId: string | null; ownerUnknown: boolean },
  ): void => {
    if (status.ownerUnknown) return;
    applyExplicitAccountUserId(status.userId);
  };
  const seedAccountContinuity = (userId: string, expiresAtMs: number | null): void => {
    const nowMs = Date.now();
    const localExpiry = expiresAtMs != null && expiresAtMs > nowMs
      ? expiresAtMs
      : nowMs + ACCOUNT_AUTH_TRANSIENT_IDENTITY_GRACE_MS;
    accountAuthorizationContinuityUserId = userId;
    accountAuthorizationContinuityUntilMs = Math.min(
      localExpiry,
      nowMs + ACCOUNT_AUTH_TRANSIENT_IDENTITY_GRACE_MS,
    );
  };
  /**
   * The verdict travels WITH the answer rather than in a shared flag: two
   * concurrent callers each await inside this function, and a module-level
   * "ownership is unknown" bit would be read by one caller after the other
   * caller's read overwrote it. `ownerUnknown` here is the verdict of the last
   * status read this call made, and nobody else's.
   */
  const getAccountLeaseUserId = async (): Promise<{
    userId: string | null;
    ownerUnknown: boolean;
  }> => {
    const initialStatus = readExplicitAccountStatus();
    const ownerUserId = initialStatus.userId;
    applyExplicitAccountUserIdFromStatus(initialStatus);
    if (!ownerUserId) return { userId: null, ownerUnknown: initialStatus.ownerUnknown };
    // Retained ownership has no live token to prove with, and asking for one
    // would only churn a grant this machine already knows is dead. The identity
    // is unchanged, so already-paired devices keep connecting.
    if (initialStatus.retained) {
      return { userId: ownerUserId, ownerUnknown: initialStatus.ownerUnknown };
    }
    if (accountAuthorizationContinuityUserId !== ownerUserId) {
      seedAccountContinuity(ownerUserId, initialStatus.expiresAtMs);
    }
    try {
      const hostToken = (await accountAuthService.getAccessToken()).trim();
      const refreshedStatus = readExplicitAccountStatus();
      const refreshedUserId = refreshedStatus.userId;
      if (refreshedUserId !== accountAuthorizationUserId) applyExplicitAccountUserIdFromStatus(refreshedStatus);
      const ownerUnknown = refreshedStatus.ownerUnknown;
      // The token round trip can itself be what marks the session expired.
      // Re-read ownership so that lands as retained, not as a lost lease.
      if (refreshedStatus.retained && refreshedUserId === ownerUserId) {
        return { userId: ownerUserId, ownerUnknown };
      }
      if (!hostToken || refreshedUserId !== ownerUserId) return { userId: null, ownerUnknown };
      seedAccountContinuity(ownerUserId, refreshedStatus.expiresAtMs);
      return { userId: ownerUserId, ownerUnknown };
    } catch {
      const refreshedStatus = readExplicitAccountStatus();
      const refreshedUserId = refreshedStatus.userId;
      if (refreshedUserId !== accountAuthorizationUserId) applyExplicitAccountUserIdFromStatus(refreshedStatus);
      const ownerUnknown = refreshedStatus.ownerUnknown;
      if (refreshedStatus.retained && refreshedUserId === ownerUserId) {
        return { userId: ownerUserId, ownerUnknown };
      }
      return refreshedUserId === ownerUserId
        && accountAuthorizationContinuityUserId === ownerUserId
        && Date.now() <= accountAuthorizationContinuityUntilMs
        ? { userId: ownerUserId, ownerUnknown }
        : { userId: null, ownerUnknown };
    }
  };
  const captureAccountAuthorization = async (): Promise<{
    userId: string;
    generation: number;
  } | null> => {
    const { userId } = await getAccountLeaseUserId();
    return userId ? { userId, generation: accountAuthorizationGeneration } : null;
  };
  const verifyRelayAccountProof = async (
    token: string | null | undefined,
  ): Promise<VerifiedAccountAttestation | null> => {
    const before = await captureAccountAuthorization();
    const relayAccountToken = token?.trim() ?? "";
    if (!before || !relayAccountToken) return null;
    // A build that cannot verify accounts at all cannot verify a relay proof
    // either. Same answer this used to reach by way of a thrown
    // `configuration_error`, without pretending the config exists.
    const config = getAccountAttestationConfig();
    if (!config) return null;
    try {
      const attestation = await verifyAccountAttestation({
        token: relayAccountToken,
        expectedUserId: before.userId,
        config,
      });
      const after = await captureAccountAuthorization();
      if (
        !after
        || after.userId !== before.userId
        || after.generation !== before.generation
        || attestation.userId !== before.userId
      ) return null;
      return attestation;
    } catch {
      return null;
    }
  };
  const localDeviceId = ensureSecretFile(args.localDeviceIdPath, 16);
  const localSiteId = ensureSecretFile(args.localSiteIdPath, 16);
  // This fallback has no host-side heartbeat timeout; the value is advertised
  // to clients. A 5s default made an otherwise idle Relay tunnel wake its DO
  // for a ping/pong cycle twelve times per minute while no project host existed.
  const heartbeatIntervalMs = Math.max(5_000, Math.floor(args.heartbeatIntervalMs ?? 60_000));
  const pollIntervalMs = Math.max(100, Math.floor(args.pollIntervalMs ?? 1_500));
  const authTimeoutMs = Math.max(1_000, Math.floor(args.authTimeoutMs ?? BRAIN_SYNC_AUTH_TIMEOUT_MS));
  const pairFailures = createPairFailureTracker();
  const pairedChannelService = createSyncPairedChannelService<WebSocket>({
    logger: args.logger,
    getBufferedAmount: (ws) => ws.bufferedAmount,
    send: (ws, type, payload) => send(ws, type, payload),
  });

  const brainMetadata = (): SyncPeerMetadata => ({
    deviceId: localDeviceId,
    deviceName: resolveDeviceDisplayName(),
    platform: mapPlatform(process.platform),
    deviceType: "desktop",
    siteId: localSiteId,
    dbVersion: 0,
  });

  const sendActionResult = async <TPayload>(
    peer: BrainPeerState,
    requestId: string | null | undefined,
    resultType: "project_open_result" | "project_create_result" | "project_clone_result",
    unavailableMessage: string,
    payload: TPayload,
    action: ((payload: TPayload) => Promise<SyncMobileProjectSummary>) | undefined,
    isCurrent: () => boolean,
  ): Promise<void> => {
    if (!action) {
      send(peer.ws, resultType, { ok: false, message: unavailableMessage }, requestId);
      return;
    }
    try {
      const project = await action(payload);
      if (!isCurrent()) return;
      send(peer.ws, resultType, { ok: true, project }, requestId);
      const catalog = await projectCatalog(args.projectCatalogProvider, args.logger);
      if (!isCurrent()) return;
      sendProjectCatalog(peer.ws, catalog);
    } catch (error) {
      if (!isCurrent()) return;
      send(peer.ws, resultType, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  };

  const handleAuthenticatedEnvelope = async (
    peer: BrainPeerState,
    envelope: ReturnType<typeof parseSyncEnvelope>,
    isCurrent: () => boolean,
  ): Promise<void> => {
    if (isPairedRuntimeEnvelopeType(envelope.type)) {
      await pairedChannelService.handleEnvelope(
        peer.ws,
        envelope.type,
        envelope.payload,
        peer.authKind === "paired",
        // Runtime RPC channel + port-forward are desktop-runtime-host only.
        peer.authKind === "paired" && isRuntimeHostPairingRecord(peer.pairingRecord),
      );
      return;
    }
    switch (envelope.type) {
      case "project_catalog_request": {
        const catalog = await projectCatalog(args.projectCatalogProvider, args.logger);
        if (!isCurrent()) return;
        sendProjectCatalog(peer.ws, catalog, envelope.requestId);
        break;
      }
      case "project_switch_request": {
        let result = null as Awaited<ReturnType<SyncProjectCatalogProvider["prepareProjectConnection"]>> | null;
        let completionAttempted = false;
        let resultSent = false;
        try {
          result = await args.projectCatalogProvider.prepareProjectConnection(
            (envelope.payload ?? {}) as SyncProjectSwitchRequestPayload,
          );
          if (!isCurrent()) return;
          send(peer.ws, "project_switch_result", result, envelope.requestId);
          resultSent = true;
          completionAttempted = true;
          await args.projectCatalogProvider.completeProjectConnection?.(
            (envelope.payload ?? {}) as SyncProjectSwitchRequestPayload,
            result,
          );
          if (!isCurrent()) return;
        } catch (error) {
          if (!isCurrent()) return;
          args.logger.warn("sync_brain.project_switch_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          if (result && !completionAttempted) {
            try {
              await args.projectCatalogProvider.completeProjectConnection?.(
                (envelope.payload ?? {}) as SyncProjectSwitchRequestPayload,
                result,
              );
              if (!isCurrent()) return;
            } catch {
              // Best effort; the peer will retry selection if handoff fails.
            }
          }
          if (!resultSent) {
            send(peer.ws, "project_switch_result", {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }, envelope.requestId);
          }
        }
        break;
      }
      case "project_forget_request": {
        if (!args.projectCatalogProvider.forgetProject) {
          send(peer.ws, "project_forget_result", {
            ok: false,
            message: "Removing projects is not available from this machine.",
          } satisfies SyncProjectForgetResultPayload, envelope.requestId);
          break;
        }
        try {
          const result = await args.projectCatalogProvider.forgetProject(
            (envelope.payload ?? {}) as SyncProjectForgetRequestPayload,
          );
          if (!isCurrent()) return;
          send(peer.ws, "project_forget_result", result, envelope.requestId);
          if (result.ok) {
            const catalog = await projectCatalog(args.projectCatalogProvider, args.logger);
            if (!isCurrent()) return;
            sendProjectCatalog(peer.ws, catalog);
          }
        } catch (error) {
          if (!isCurrent()) return;
          send(peer.ws, "project_forget_result", {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          } satisfies SyncProjectForgetResultPayload, envelope.requestId);
        }
        break;
      }
      case "project_browse_request": {
        try {
          const result = await args.projectCatalogProvider.browseDirectories?.(
            (envelope.payload ?? {}) as ProjectBrowseInput,
          );
          if (!isCurrent()) return;
          send(peer.ws, "project_browse_result", result
            ? { ok: true, result }
            : { ok: false, message: "Project browsing is not available from this machine." }, envelope.requestId);
        } catch (error) {
          if (!isCurrent()) return;
          send(peer.ws, "project_browse_result", {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }, envelope.requestId);
        }
        break;
      }
      case "project_default_parent_dir_request": {
        try {
          const parentDir = await args.projectCatalogProvider.getDefaultParentDir?.();
          if (!isCurrent()) return;
          send(peer.ws, "project_default_parent_dir", parentDir
            ? { ok: true, parentDir }
            : { ok: false, message: "Default project directory is not available from this machine." }, envelope.requestId);
        } catch (error) {
          if (!isCurrent()) return;
          send(peer.ws, "project_default_parent_dir", {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }, envelope.requestId);
        }
        break;
      }
      case "project_open_request": {
        await sendActionResult(
          peer,
          envelope.requestId,
          "project_open_result",
          "Opening projects is not available from this machine.",
          (envelope.payload ?? {}) as SyncProjectOpenRequestPayload,
          args.projectCatalogProvider.openProject,
          isCurrent,
        );
        break;
      }
      case "project_create_request": {
        await sendActionResult(
          peer,
          envelope.requestId,
          "project_create_result",
          "Creating projects is not available from this machine.",
          (envelope.payload ?? {}) as CreateProjectInput,
          args.projectCatalogProvider.createProject,
          isCurrent,
        );
        break;
      }
      case "project_clone_request": {
        await sendActionResult(
          peer,
          envelope.requestId,
          "project_clone_result",
          "Cloning projects is not available from this machine.",
          (envelope.payload ?? {}) as CloneProjectInput,
          args.projectCatalogProvider.cloneProject,
          isCurrent,
        );
        break;
      }
      case "project_list_my_github_repos_request": {
        try {
          const result = await args.projectCatalogProvider.listMyGitHubRepos?.(
            (envelope.payload ?? {}) as ListMyGitHubReposInput,
          );
          if (!isCurrent()) return;
          send(peer.ws, "project_list_my_github_repos_result", result
            ? { ok: true, result }
            : { ok: false, message: "GitHub repository listing is not available from this machine." }, envelope.requestId);
        } catch (error) {
          if (!isCurrent()) return;
          send(peer.ws, "project_list_my_github_repos_result", {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          }, envelope.requestId);
        }
        break;
      }
      case "chat_subscribe": {
        const payload = envelope.payload as SyncChatSubscribePayload | null;
        const sessionId = optionalString(payload?.sessionId);
        if (!sessionId || payload?.chatScope !== "personal" || !args.personalChatScope) break;
        const transcriptPath = await args.personalChatScope.transcriptPath(sessionId);
        if (!isCurrent()) return;
        if (!transcriptPath) {
          send(peer.ws, "chat_subscribe", {
            sessionId,
            capturedAt: nowIso(),
            truncated: false,
            events: [],
            turnActive: false,
          } satisfies SyncChatSubscribeSnapshotPayload, envelope.requestId);
          break;
        }
        const maxBytes = typeof payload.maxBytes === "number" && Number.isFinite(payload.maxBytes)
          ? Math.max(1_024, Math.min(2_000_000, Math.floor(payload.maxBytes)))
          : 256 * 1_024;
        // Capture the tail point before reading history. Events committed
        // during the snapshot can then be replayed (and client-deduped), but
        // can never fall into the gap between history collection and offset.
        const offset = await fs.promises.stat(transcriptPath)
          .then((stat) => stat.size)
          .catch(() => 0);
        if (!isCurrent()) return;
        const history = (await args.personalChatScope.call("getEventHistory", {
          sessionId,
          maxBytes,
        })).result as {
          events?: AgentChatEventEnvelope[];
          truncated?: boolean;
          tailStartOffset?: number | null;
          hasOlderHistory?: boolean;
        };
        if (!isCurrent()) return;
        const turnActive = await args.personalChatScope.isTurnActive(sessionId);
        if (!isCurrent()) return;
        peer.personalChatSubscriptions.set(sessionId, { transcriptPath, offset });
        send(peer.ws, "chat_subscribe", {
          sessionId,
          capturedAt: nowIso(),
          truncated: history.truncated === true,
          tailStartOffset: history.tailStartOffset ?? 0,
          hasOlderHistory: history.hasOlderHistory
            ?? (history.truncated === true && (history.tailStartOffset ?? 0) > 0),
          cursorKind: "byte",
          events: history.events ?? [],
          turnActive,
        } satisfies SyncChatSubscribeSnapshotPayload, envelope.requestId);
        break;
      }
      case "chat_history": {
        const payload = envelope.payload as SyncChatHistoryRequestPayload | null;
        const sessionId = optionalString(payload?.sessionId) ?? "";
        const beforeOffset = typeof payload?.beforeOffset === "number" && Number.isFinite(payload.beforeOffset)
          ? Math.max(0, Math.floor(payload.beforeOffset))
          : 0;
        if (
          !sessionId
          || payload?.chatScope !== "personal"
          || !args.personalChatScope
          || !peer.personalChatSubscriptions.has(sessionId)
        ) {
          send(peer.ws, "chat_history", unavailableChatHistoryPage(sessionId, beforeOffset), envelope.requestId);
          break;
        }
        let page = unavailableChatHistoryPage(sessionId, beforeOffset);
        try {
          const rawPage = (await args.personalChatScope.call("getEventHistoryPage", {
            sessionId,
            beforeOffset,
            ...(typeof payload.maxBytes === "number" ? { maxBytes: payload.maxBytes } : {}),
          })).result;
          page = normalizeChatHistoryPage(rawPage, sessionId, beforeOffset);
        } catch (error) {
          args.logger.warn("sync_brain.chat_history_failed", {
            sessionId,
            beforeOffset,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!isCurrent()) return;
        send(peer.ws, "chat_history", page, envelope.requestId);
        break;
      }
      case "chat_unsubscribe": {
        const payload = envelope.payload as SyncChatUnsubscribePayload | null;
        if (payload?.chatScope === "personal") {
          const sessionId = optionalString(payload.sessionId);
          if (sessionId) peer.personalChatSubscriptions.delete(sessionId);
        }
        break;
      }
      case "heartbeat": {
        const payload = envelope.payload as { kind?: string; sentAt?: string } | null;
        if (payload?.kind === "ping") {
          send(peer.ws, "heartbeat", {
            kind: "pong",
            sentAt: payload.sentAt ?? nowIso(),
            dbVersion: 0,
          }, envelope.requestId);
        }
        break;
      }
      case "command": {
        // No project sync host owns this peer (it is parked on the brain-level
        // ingress — e.g. the host is restarting or was blocked by a conflicting
        // sync listener). Silently dropping the command leaves the phone
        // staring at a 30s timeout and a vague "took too long" banner for
        // EVERY surface; answer immediately with a self-describing failure so
        // the app can show what actually happened and retry.
        const payload = envelope.payload as SyncCommandPayload | null;
        const commandId = typeof payload?.commandId === "string" && payload.commandId
          ? payload.commandId
          : envelope.requestId ?? "";
        const action = typeof payload?.action === "string" ? payload.action : "";
        const commandArgs = payload?.args ?? {};
        const descriptor = action.startsWith("personalChats.")
          ? personalChatCommandDescriptors(args.personalChatScope).find((entry) => entry.action === action)
          : undefined;
        if (action.startsWith("personalChats.") && args.personalChatScope && descriptor) {
          send(peer.ws, "command_ack", {
            commandId,
            accepted: true,
            status: "accepted",
            message: `Executing ${action}.`,
          }, envelope.requestId);
          try {
            const result = action === "personalChats.streamEvents"
              ? await args.personalChatScope.streamEvents(commandArgs)
              : (await args.personalChatScope.call(
                  action.slice("personalChats.".length),
                  commandArgs,
                )).result;
            if (!isCurrent()) return;
            send(peer.ws, "command_result", { commandId, ok: true, result }, envelope.requestId);
          } catch (error) {
            if (!isCurrent()) return;
            send(peer.ws, "command_result", {
              commandId,
              ok: false,
              error: {
                code: "command_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            }, envelope.requestId);
          }
          break;
        }
        args.logger.warn("sync_brain.command_without_project_host", {
          action: typeof payload?.action === "string" ? payload.action : null,
          peerDeviceId: peer.metadata?.deviceId ?? null,
        });
        send(peer.ws, "command_result", {
          commandId,
          ok: false,
          error: {
            code: "host_unavailable",
            message: "This machine's project sync host is not running yet. It usually restarts within a few seconds — retry shortly, or reopen the project.",
          },
        }, envelope.requestId);
        break;
      }
      default:
        args.logger.warn("sync_brain.unsupported_envelope", {
          type: envelope.type,
          peerDeviceId: peer.metadata?.deviceId ?? null,
        });
        break;
    }
  };

  return ({ ws, remoteAddress, transportOrigin }) => {
    const peer: BrainPeerState = {
      ws,
      lifecycleGeneration: 0,
      authenticated: false,
      authKind: null,
      authTimeout: null,
      metadata: null,
      personalChatSubscriptions: new Map(),
      pairingRecord: null,
      relayAuthorization: null,
      messageQueue: Promise.resolve(),
    };
    const isPeerCurrent = (generation: number): boolean =>
      peer.lifecycleGeneration === generation && peer.ws.readyState === WS_OPEN;
    const installRelayAuthorization = (initial: {
      ownerUserId: string;
      expiresAtMs: number;
      challenge: string;
    } | null): void => {
      peer.relayAuthorization?.dispose();
      peer.relayAuthorization = null;
      if (!initial || transportOrigin !== "relay-bridge") return;
      const lifecycle = createRelayAuthorizationLifecycle({
        capable: Boolean(
          peer.metadata?.capabilities?.includes(SYNC_RELAY_REAUTHORIZE_V1_CAPABILITY),
        ),
        deviceId: () => peer.metadata?.deviceId ?? null,
        pinnedPublicKey: () => peer.pairingRecord?.dpopPublicKey ?? null,
        captureHostAuthorization: captureAccountAuthorization,
        verifyAccountToken: async (token, expectedUserId) => {
          const config = getAccountAttestationConfig();
          if (!config) {
            throw new Error("This machine cannot verify ADE accounts.");
          }
          return await verifyAccountAttestation({ token, expectedUserId, config });
        },
        sendResult: (payload, requestId) => {
          send(peer.ws, "relay_reauthorize_result", payload, requestId);
        },
        close: (reason) => {
          args.logger.warn("sync_brain.relay_authorization_closed", {
            reason,
            peerDeviceId: peer.metadata?.deviceId ?? null,
            peerDeviceName: peer.metadata?.deviceName ?? null,
            remoteAddress: remoteAddress ?? null,
          });
          pairedChannelService.closePeer(peer.ws, reason, true);
          peer.authenticated = false;
          try {
            peer.ws.close(SYNC_RELAY_AUTHORIZATION_CLOSE_CODE, reason);
          } catch {
            // ignore close failures
          }
        },
        logger: args.logger,
      });
      lifecycle.initialize(initial);
      peer.relayAuthorization = lifecycle;
    };
    let personalChatPumpRunning = false;
    const personalChatPump = setInterval(() => {
      if (!peer.authenticated || peer.ws.readyState !== WS_OPEN || personalChatPumpRunning) return;
      const lifecycleGeneration = peer.lifecycleGeneration;
      personalChatPumpRunning = true;
      void (async () => {
        const expectedOwner = optionalString(peer.pairingRecord?.accountOwnerUserId)
          ?? peer.relayAuthorization?.snapshot()?.ownerUserId
          ?? null;
        if (expectedOwner) {
          const { userId: currentOwner, ownerUnknown } = await getAccountLeaseUserId();
          if (!isPeerCurrent(lifecycleGeneration)) return;
          // Unknown ownership is not a mismatch — `null` there means "no
          // answer", not "nobody".
          if (currentOwner !== expectedOwner && !ownerUnknown) {
            pairingStore.revokeAccountOwnedExcept(currentOwner);
            peer.authenticated = false;
            peer.metadata = null;
            peer.authKind = null;
            peer.pairingRecord = null;
            peer.relayAuthorization?.dispose();
            peer.relayAuthorization = null;
            try {
              peer.ws.close(SYNC_RELAY_AUTHORIZATION_CLOSE_CODE, "ADE account session changed");
            } catch {
              // ignore close failures
            }
            return;
          }
        }
        for (const [sessionId, subscription] of peer.personalChatSubscriptions) {
          const next = await readPersonalChatEventsSince(subscription.transcriptPath, subscription.offset);
          if (!isPeerCurrent(lifecycleGeneration)) return;
          for (const event of next.events) send(peer.ws, "chat_event", event);
          subscription.offset = next.nextOffset;
          peer.personalChatSubscriptions.set(sessionId, subscription);
        }
      })().finally(() => {
        personalChatPumpRunning = false;
      });
    }, pollIntervalMs);
    personalChatPump.unref?.();
    const clearAuthTimeout = (): void => {
      if (!peer.authTimeout) return;
      clearTimeout(peer.authTimeout);
      peer.authTimeout = null;
    };
    peer.authTimeout = setTimeout(() => {
      if (peer.authenticated || peer.ws.readyState !== WS_OPEN) return;
      args.logger.warn("sync_brain.auth_timeout", {
        remoteAddress: remoteAddress ?? null,
      });
      try {
        peer.ws.close(4003, "Authentication timed out");
      } catch {
        // ignore close failures
      }
    }, authTimeoutMs);
    peer.authTimeout.unref?.();
    ws.on("message", (data: RawData) => {
      const lifecycleGeneration = peer.lifecycleGeneration;
      let envelope: ReturnType<typeof parseSyncEnvelope>;
      try {
        envelope = parseSyncEnvelope(wsDataToText(data));
      } catch (error) {
        if (error instanceof SyncProtocolVersionMismatchError) {
          const payload = sendSyncProtocolVersionMismatchAndClose(
            peer.ws,
            error,
            () => {
              clearAuthTimeout();
            },
          );
          args.logger.warn("sync_brain.protocol_version_mismatch", {
            receivedVersion: payload.receivedVersion,
            currentVersion: payload.currentVersion,
            minSupportedVersion: payload.minSupportedVersion,
            remoteAddress: remoteAddress ?? null,
          });
          return;
        }
        args.logger.warn("sync_brain.invalid_envelope", {
          error: error instanceof Error ? error.message : String(error),
          remoteAddress: remoteAddress ?? null,
        });
        return;
      }

      if (peer.authenticated && envelope.type === "relay_reauthorize") {
        if (!peer.relayAuthorization) {
          send(peer.ws, "relay_reauthorize_result", {
            ok: false,
            error: {
              code: "invalid_request",
              message: "This connection does not have a refreshable Relay authorization lease.",
              retryable: false,
            },
          }, envelope.requestId);
          return;
        }
        void peer.relayAuthorization.handle(envelope.payload, envelope.requestId).catch((error) => {
          args.logger.warn("sync_brain.relay_reauthorization_failed", {
            error: error instanceof Error ? error.message : String(error),
            peerDeviceId: peer.metadata?.deviceId ?? null,
            requestId: envelope.requestId,
          });
        });
        return;
      }

      peer.messageQueue = peer.messageQueue.catch(() => {}).then(async () => {
        if (!isPeerCurrent(lifecycleGeneration)) return;

        if (!peer.authenticated) {
          if (envelope.type === "pairing_request") {
            const payload = parsePairingRequestPayload(envelope.payload);
            if (!payload) {
              send(ws, "pairing_result", {
                ok: false,
                error: { code: "pairing_failed", message: "Invalid pairing request." },
              }, envelope.requestId);
              try {
                ws.close(4003, "Pairing failed");
              } catch {
                // ignore close failures
              }
              return;
            }
            if (
              transportOrigin === "relay-bridge"
              && !await verifyRelayAccountProof(payload.relayAccountToken)
            ) {
              if (!isPeerCurrent(lifecycleGeneration)) return;
              send(ws, "pairing_result", {
                ok: false,
                error: {
                  code: "relay_account_required",
                  message: "Sign in with the same ADE account on both machines.",
                },
              }, envelope.requestId);
              try {
                ws.close(4003, "Account sign-in required");
              } catch {
                // ignore close failures
              }
              return;
            }
            if (!isPeerCurrent(lifecycleGeneration)) return;
            const pairFailureSubject: PairFailureSubject = {
              ip: remoteAddress ?? null,
              deviceId: payload.peer.deviceId,
            };
            const cooldownMs = pairFailures.cooldownMsRemaining(pairFailureSubject);
            if (cooldownMs > 0) {
              const minutes = Math.ceil(cooldownMs / 60_000);
              send(ws, "pairing_result", {
                ok: false,
                error: {
                  code: "pairing_failed",
                  message: `Too many failed PIN attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
                },
              }, envelope.requestId);
              try {
                ws.close(4004, "Pairing cooldown");
              } catch {
                // ignore close failures
              }
              return;
            }
            try {
              const paired = pairingStore.pairPeer(payload.peer, payload.code, {
                dpopPublicKey: payload.dpopPublicKey ?? null,
                runtimeHostGrant: payload.runtimeHostGrant ?? null,
              });
              pairFailures.clearAfterSuccess(pairFailureSubject);
              send(ws, "pairing_result", {
                ok: true,
                deviceId: paired.deviceId,
                secret: paired.secret,
                ...(paired.pendingRotationExpiresAtMs != null
                  ? {
                      rotation: {
                        pendingCommit: true,
                        expiresInMs: Math.max(0, paired.pendingRotationExpiresAtMs - Date.now()),
                      },
                    }
                  : {}),
              } satisfies SyncPairingResultPayload, envelope.requestId);
            } catch (error) {
              const code = (error as { code?: string } | null)?.code === "pin_not_set"
                ? "pin_not_set"
                : (error as { code?: string } | null)?.code === "invalid_pin"
                ? "invalid_pin"
                : "pairing_failed";
              send(ws, "pairing_result", {
                ok: false,
                error: {
                  code,
                  message: error instanceof Error ? error.message : "Unable to pair this device.",
                },
              }, envelope.requestId);
              if (code === "invalid_pin" || code === "pairing_failed") {
                pairFailures.registerFailure(pairFailureSubject);
              }
              try {
                ws.close(4003, "Pairing failed");
              } catch {
                // ignore close failures
              }
            }
            return;
          }
          if (envelope.type !== "hello") {
            send(ws, "hello_error", {
              code: "invalid_hello",
              message: "Authenticate with hello or pairing_request before sending other messages.",
            }, envelope.requestId);
            try {
              ws.close(4003, "Authentication required");
            } catch {
              // ignore close failures
            }
            return;
          }
          const hello = parseHelloPayload(envelope.payload);
          if (!hello) {
            send(ws, "hello_error", {
              code: "invalid_hello",
              message: "Invalid hello payload.",
            }, envelope.requestId);
            try {
              ws.close(4003, "Invalid hello");
            } catch {
              // ignore close failures
            }
            return;
          }
          const auth = hello.auth;
          let authenticatedPairingRecord: SyncPairingRecord | null = null;
          let relayAccountOwnerUserId: string | null = null;
          let relayAccountExpiresAtMs: number | null = null;
          // Fresh secret handed back only on first-time verified account
          // adoption, exactly as the project host does it.
          let accountPairing: { deviceId: string; secret: string } | null = null;
          const authFailure = {
            code: "auth_failed" as SyncHelloErrorPayload["code"],
            // A bare "Sync authentication failed." leaves the user with no idea
            // whether to re-pair, sign in, or update. Each branch that can fail
            // for a nameable reason overwrites this.
            message: null as string | null,
          };
          const authFail = (message: string, code?: SyncHelloErrorPayload["code"]): true => {
            authFailure.message = message;
            if (code) authFailure.code = code;
            return true;
          };
          /**
           * Account hellos on a machine with no project scope.
           *
           * These used to be refused here on the theory that only the project
           * sync host owns the account session and attestation config. It does
           * not: this handler already resolves both (see `accountAuthService`
           * and `getAccountAttestationConfig` above), and refusing them is what
           * made ADE's headline promise — install, sign in, connect from
           * anywhere — impossible until the user opened a project. The web
           * client authenticates this way and nothing else.
           *
           * The gates are the project host's, literally: `syncAccountHelloAuth`
           * is the one implementation both ingresses run. This side passes no
           * arbitration and no sealed adoption, because the brain serves
           * neither.
           */
          const authenticateAccountHello = async (
            accountAuth: SyncAccountHelloAuth,
          ): Promise<boolean> => {
            const result = await authenticateSyncAccountHello({
              auth: accountAuth,
              peer: hello.peer,
              transportOrigin,
              logger: args.logger,
              logPrefix: "sync_ingress",
              pairingStore,
              dpopNonceCache,
              captureAccountAuthorization,
              getAccountAttestationConfig,
              verifyAccountAttestation,
              withCommitLock: withAccountHelloCommitLock,
              isPeerCurrent: () => isPeerCurrent(lifecycleGeneration),
              pairingCodeNoun: "code",
              // The brain's only account route is Relay, so a machine with no
              // session is a relay-account problem, not a pairing one.
              notSignedInCode: "relay_account_required",
            });
            // `superseded` cannot occur here: arbitration is host-only and this
            // side passes no arbiter. Treated as a non-committing failure.
            if (result.kind === "stale" || result.kind === "superseded") return true;
            if (result.kind === "rejected") return authFail(result.message, result.code);
            authenticatedPairingRecord = result.pairingRecord;
            accountPairing = result.accountPairing;
            relayAccountOwnerUserId = result.attestation.userId;
            relayAccountExpiresAtMs = result.attestation.expiresAtMs;
            return false;
          };
          const authFailed = await (async () => {
            if (auth?.kind === "paired") {
              if (auth.deviceId !== hello.peer.deviceId) return true;
              if (transportOrigin === "relay-bridge") {
                const attestation = await verifyRelayAccountProof(auth.relayAccountToken);
                if (!isPeerCurrent(lifecycleGeneration)) return true;
                if (!attestation) {
                  authFailure.code = "relay_account_required";
                  return true;
                }
                relayAccountOwnerUserId = attestation.userId;
                relayAccountExpiresAtMs = attestation.expiresAtMs;
              }
              const knownRecord = pairingStore.getPairingRecord(auth.deviceId);
              if (!pairingStore.authenticate(auth.deviceId, auth.secret)) {
                // Deliberately identical for both cases. This machine knows
                // which it is and logs it, but telling an UNAUTHENTICATED
                // caller whether a device id exists here turns the handshake
                // into an existence oracle — and the user's next step is the
                // same either way.
                args.logger.warn("sync_ingress.paired_device_rejected", {
                  deviceId: auth.deviceId,
                  reason: knownRecord ? "secret_mismatch" : "unknown_device",
                });
                return authFail(SYNC_REPAIR_REQUIRED_MESSAGE, "repair_required");
              }
              authenticatedPairingRecord = pairingStore.getPairingRecord(auth.deviceId);
              if (!authenticatedPairingRecord) {
                return authFail(SYNC_REPAIR_REQUIRED_MESSAGE, "repair_required");
              }
              const pairingOwner = optionalString(authenticatedPairingRecord.accountOwnerUserId);
              if (pairingOwner) {
                const { userId: currentOwner, ownerUnknown } = await getAccountLeaseUserId();
                if (!isPeerCurrent(lifecycleGeneration)) return true;
                // Unknown ownership is not a mismatch — `null` there means
                // "no answer", not "nobody".
                if (currentOwner !== pairingOwner && !ownerUnknown) {
                  // Reached only for a real owner change — an expired or
                  // unreadable session retains the last known owner, or reports
                  // no answer at all, and lands above still paired.
                  pairingStore.revokeAccountOwnedExcept(currentOwner);
                  args.logger.warn("sync_ingress.paired_account_owner_mismatch", {
                    deviceId: auth.deviceId,
                    hasCurrentOwner: Boolean(currentOwner),
                  });
                  return authFail(
                    "This machine is signed in to a different ADE account than the one that paired this device.",
                  );
                }
              }
              const dpopFailure = evaluatePairedHelloDpop({
                storedPublicKey: authenticatedPairingRecord.dpopPublicKey,
                deviceId: auth.deviceId,
                secret: auth.secret,
                proof: auth.dpop ?? null,
                requireDpop: securityStore.getRequireDpop(),
                nonceCache: dpopNonceCache,
                adoptPublicKey: (publicKey) => {
                  pairingStore.adoptDpopPublicKey(auth.deviceId, publicKey);
                },
              });
              if (dpopFailure) {
                args.logger.warn("sync_ingress.dpop_rejected", { deviceId: auth.deviceId, reason: dpopFailure });
                return true;
              }
              return false;
            }
            if (auth?.kind === "account") {
              return await authenticateAccountHello(auth);
            }
            if (auth?.kind === "account_sealed") {
              // Sealed adoption rides an `account_challenge` round trip this
              // handler does not serve. Say so plainly instead of failing as an
              // unreadable payload — the device's next move is a PIN pair. Not
              // `auth_failed`: the saved pairing, if any, is untouched by this.
              return authFail(
                "This machine cannot finish that sign-in here. Pair with a code, or open a project on it and try again.",
                "account_session_changed",
              );
            }
            if (!auth || auth.kind !== "bootstrap" || !safeStringEquals(bootstrapToken, auth.token)) return true;
            if (transportOrigin === "relay-bridge") {
              authFailure.code = "relay_account_required";
              return true;
            }
            // DPoP-upgraded devices must not enter through the shared
            // bootstrap token — that would bypass the enclave key binding.
            if (pairingStore.getPairingRecord(hello.peer.deviceId)?.dpopPublicKey) return true;
            // Strict posture mirrors the project host: with require-DPoP on,
            // the bootstrap token never satisfies a LAN hello.
            if (securityStore.getRequireDpop() && !SYNC_HOST_BIND_LOOPBACK_ONLY) {
              args.logger.warn("sync_ingress.dpop_required_bootstrap_rejected", {
                deviceId: hello.peer.deviceId,
              });
              return true;
            }
            return !SYNC_HOST_BIND_LOOPBACK_ONLY && !pairingStore.hasPairingRecord(hello.peer.deviceId);
          })();
          if (!isPeerCurrent(lifecycleGeneration)) return;
          if (authFailed) {
            // Same attribution as the project host's auth_failed: name the
            // rejecting machine so clients never drop a saved pairing over a
            // rejection they cannot attribute to the paired machine.
            const rejectingHost = brainMetadata();
            send(ws, "hello_error", {
              code: authFailure.code,
              // A named cause when a branch supplied one; the generic wording
              // survives only for the checks that genuinely cannot say more.
              message: authFailure.message
                ?? (authFailure.code === "relay_account_required"
                  ? "Sign in with the same ADE account on both machines."
                  : "Sync authentication failed."),
              host: {
                deviceId: rejectingHost.deviceId,
                name: rejectingHost.deviceName,
              },
            }, envelope.requestId);
            try {
              ws.close(4003, "Authentication failed");
            } catch {
              // ignore close failures
            }
            return;
          }
          peer.authenticated = true;
          // `account` is record-backed exactly like `paired` once it commits:
          // the device now holds a real pairing record and must be treated as
          // paired for channel access and cleanup.
          const recordBackedAuth = auth?.kind === "paired" || auth?.kind === "account";
          peer.authKind = auth?.kind === "bootstrap" || recordBackedAuth
            ? (auth.kind === "account" ? "paired" : auth.kind)
            : null;
          clearAuthTimeout();
          peer.metadata = hello.peer;
          peer.pairingRecord = recordBackedAuth ? authenticatedPairingRecord : null;
          installRelayAuthorization(
            transportOrigin === "relay-bridge"
              && relayAccountOwnerUserId
              && relayAccountExpiresAtMs != null
              ? {
                  ownerUserId: relayAccountOwnerUserId,
                  expiresAtMs: relayAccountExpiresAtMs,
                  challenge: randomBytes(24).toString("base64url"),
                }
              : null,
          );
          const catalog = await projectCatalog(args.projectCatalogProvider, args.logger);
          if (!isPeerCurrent(lifecycleGeneration)) return;
          const brain = brainMetadata();
          const personalDescriptors = personalChatCommandDescriptors(args.personalChatScope);
          const negotiatedCompression = negotiateSyncApplicationCompression(hello.compression);
          const helloOkPayload = buildSyncHostHelloOkPayload({
            peer: hello.peer,
            brain,
            serverDbVersion: 0,
            heartbeatIntervalMs,
            pollIntervalMs,
            compression: negotiatedCompression,
            projectCatalog: catalog,
            projectCatalogEnabled: true,
            crossProjectChatEnabled: false,
            projectActionsEnabled: projectActionsEnabled(args.projectCatalogProvider),
            remoteCommandSupportedActions: personalDescriptors.map((entry) => entry.action),
            remoteCommandDescriptors: personalDescriptors,
            localCommandDescriptors: [],
            compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
            cloudRelayWssUrl: accountAuthService.getStatus().signedIn
              ? args.getCloudRelayWssUrl?.() ?? null
              : null,
            relayAuthorization: peer.relayAuthorization?.metadata() ?? null,
            terminalInputAckEnabled: false,
            // Handed back only on first-time account adoption, so the device
            // can reconnect directly later with a real paired secret instead of
            // depending on the relay every time.
            accountPairing,
            // Advertise the runtime RPC channel + port-forward only to paired
            // desktop runtime-hosts (phones/browsers stay on the allowlist).
            runtimeChannelEnabled:
              recordBackedAuth && isRuntimeHostPairingRecord(authenticatedPairingRecord),
          });
          // The selection frame itself must retain the legacy wire encoding.
          // Apply the selected codec only after it has been queued successfully.
          if (send(ws, "hello_ok", helloOkPayload, envelope.requestId)) {
            if (negotiatedCompression) {
              brainPeerCompressionBySocket.set(ws, negotiatedCompression);
            } else {
              brainPeerCompressionBySocket.delete(ws);
            }
          }
          return;
        }

        await handleAuthenticatedEnvelope(
          peer,
          envelope,
          () => isPeerCurrent(lifecycleGeneration),
        );
      }).catch((error) => {
        args.logger.warn("sync_brain.envelope_failed", {
          error: error instanceof Error ? error.message : String(error),
          peerDeviceId: peer.metadata?.deviceId ?? null,
        });
      });
    });
    ws.on("error", (error) => {
      args.logger.warn("sync_brain.socket_error", {
        error: error instanceof Error ? error.message : String(error),
        peerDeviceId: peer.metadata?.deviceId ?? null,
      });
    });
    ws.on("close", (code, reason) => {
      const closedMetadata = peer.metadata;
      const wasAuthenticated = peer.authenticated;
      peer.lifecycleGeneration += 1;
      clearAuthTimeout();
      peer.relayAuthorization?.dispose();
      peer.relayAuthorization = null;
      brainPeerCompressionBySocket.delete(ws);
      peer.authenticated = false;
      peer.authKind = null;
      peer.metadata = null;
      peer.pairingRecord = null;
      clearInterval(personalChatPump);
      peer.personalChatSubscriptions.clear();
      pairedChannelService.closePeer(ws, "Sync socket closed.", false);
      args.logger.info("sync_brain.peer_closed", {
        code,
        reason: reason.toString("utf8") || null,
        peerDeviceId: closedMetadata?.deviceId ?? null,
        peerDeviceName: closedMetadata?.deviceName ?? null,
        remoteAddress: remoteAddress ?? null,
        authenticated: wasAuthenticated,
      });
    });
  };
}
