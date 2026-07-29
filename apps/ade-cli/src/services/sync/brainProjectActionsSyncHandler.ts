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
  SyncHelloPayload,
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
import { createSyncPairingStore, type SyncPairingRecord } from "./syncPairingStore";
import { createSyncDpopNonceCache, evaluatePairedHelloDpop } from "./syncDpop";
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
import { createSyncPinStore } from "./syncPinStore";
import { createSyncSecurityStore } from "./syncSecurityStore";
import {
  DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
  encodeSyncEnvelope,
  mapPlatform,
  negotiateSyncApplicationCompression,
  normalizeSyncApplicationCompressionOffer,
  parseSyncEnvelope,
  sendSyncProtocolVersionMismatchAndClose,
  SyncProtocolVersionMismatchError,
  wsDataToText,
} from "./syncProtocol";
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
  pairingSecretsPath: string;
  pinPath: string;
  localDeviceIdPath: string;
  localSiteIdPath: string;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  authTimeoutMs?: number;
  /** Mirrors SyncHostServiceArgs.getCloudRelayWssUrl for the fallback hello_ok. */
  getCloudRelayWssUrl?: () => string | null;
  accountAuthService?: Pick<AccountAuthService, "getStatus" | "getAccessToken">;
  getAccountAttestationConfig?: () => AccountAttestationConfig;
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
const BOOTSTRAP_TOKEN_KEY = "sync.bootstrapToken.v1";
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

function normalizePeerMetadata(value: unknown): SyncPeerMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const deviceId = optionalString(record.deviceId);
  const deviceName = optionalString(record.deviceName);
  const siteId = optionalString(record.siteId);
  if (!deviceId || !deviceName || !siteId) return null;
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities
      .filter((capability): capability is string => typeof capability === "string")
      .map((capability) => capability.trim())
      .filter(Boolean)
    : [];
  const appVersion = optionalString(record.appVersion);
  const appBuild = optionalString(record.appBuild);
  const bundleIdentifier = optionalString(record.bundleIdentifier);
  const dbVersionBySite: Record<string, number> = {};
  if (record.dbVersionBySite && typeof record.dbVersionBySite === "object" && !Array.isArray(record.dbVersionBySite)) {
    for (const [site, version] of Object.entries(record.dbVersionBySite as Record<string, unknown>)) {
      const normalizedSite = site.trim();
      const normalizedVersion = Number(version);
      if (normalizedSite && Number.isFinite(normalizedVersion) && normalizedVersion >= 0) {
        dbVersionBySite[normalizedSite] = Math.floor(normalizedVersion);
      }
    }
  }
  return {
    deviceId,
    deviceName,
    platform: record.platform === "iOS" || record.platform === "macOS" || record.platform === "linux" || record.platform === "windows"
      ? record.platform
      : "unknown",
    deviceType: record.deviceType === "phone" || record.deviceType === "desktop" || record.deviceType === "vps" || record.deviceType === "browser"
      ? record.deviceType
      : "unknown",
    siteId,
    dbVersion: Math.max(0, Math.floor(Number(record.dbVersion ?? 0) || 0)),
    ...(Object.keys(dbVersionBySite).length > 0 ? { dbVersionBySite } : {}),
    capabilities,
    ...(appVersion ? { appVersion } : {}),
    ...(appBuild ? { appBuild } : {}),
    ...(bundleIdentifier ? { bundleIdentifier } : {}),
  };
}

function parseHelloPayload(payload: unknown): SyncHelloPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const peer = normalizePeerMetadata(record.peer);
  if (!peer) return null;
  const compression = normalizeSyncApplicationCompressionOffer(record.compression);
  const auth = record.auth as SyncHelloPayload["auth"] | undefined;
  if (auth?.kind === "bootstrap" && optionalString(auth.token)) {
    return { peer, auth: { kind: "bootstrap", token: auth.token }, compression };
  }
  if (
    auth?.kind === "paired"
    && optionalString(auth.deviceId)
    && optionalString(auth.secret)
    && (
      auth.relayAccountToken == null
      || Boolean(optionalString(auth.relayAccountToken)?.length && auth.relayAccountToken.length <= 16_384)
    )
  ) {
    return {
      peer,
      auth: {
        kind: "paired",
        deviceId: auth.deviceId,
        secret: auth.secret,
        ...(auth.dpop ? { dpop: auth.dpop } : {}),
        ...(optionalString(auth.relayAccountToken)
          ? { relayAccountToken: optionalString(auth.relayAccountToken)! }
          : {}),
      },
      compression,
    };
  }
  const token = optionalString(record.token);
  if (token) return { peer, auth: { kind: "bootstrap", token }, compression };
  return null;
}

function parsePairingRequestPayload(payload: unknown): SyncPairingRequestPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const code = optionalString(record.code);
  const peer = normalizePeerMetadata(record.peer);
  const dpopPublicKey = optionalString(record.dpopPublicKey);
  const runtimeHostGrant = optionalString(record.runtimeHostGrant);
  const relayAccountToken = optionalString(record.relayAccountToken);
  if (record.relayAccountToken != null && (!relayAccountToken || relayAccountToken.length > 16_384)) {
    return null;
  }
  return code && peer ? {
    code,
    peer,
    ...(dpopPublicKey ? { dpopPublicKey } : {}),
    ...(relayAccountToken ? { relayAccountToken } : {}),
    ...(runtimeHostGrant ? { runtimeHostGrant } : {}),
  } : null;
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
  const pinStore = createSyncPinStore({ filePath: args.pinPath });
  const pairingStore = createSyncPairingStore({
    filePath: args.pairingSecretsPath,
    pinStore,
  });
  const dpopNonceCache = createSyncDpopNonceCache();
  const accountSecretsDir = path.dirname(args.pinPath);
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
  const readExplicitAccountStatus = (): { userId: string | null; expiresAtMs: number | null } => {
    const status = accountAuthService.getStatus();
    const userId = status.signedIn ? status.userId?.trim() || null : null;
    const expiresAtMs = status.expiresAt ? Date.parse(status.expiresAt) : Number.NaN;
    return { userId, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null };
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
  const getAccountLeaseUserId = async (): Promise<string | null> => {
    const initialStatus = readExplicitAccountStatus();
    const ownerUserId = initialStatus.userId;
    applyExplicitAccountUserId(ownerUserId);
    if (!ownerUserId) return null;
    if (accountAuthorizationContinuityUserId !== ownerUserId) {
      seedAccountContinuity(ownerUserId, initialStatus.expiresAtMs);
    }
    try {
      const hostToken = (await accountAuthService.getAccessToken()).trim();
      const refreshedStatus = readExplicitAccountStatus();
      const refreshedUserId = refreshedStatus.userId;
      if (refreshedUserId !== accountAuthorizationUserId) applyExplicitAccountUserId(refreshedUserId);
      if (!hostToken || refreshedUserId !== ownerUserId) return null;
      seedAccountContinuity(ownerUserId, refreshedStatus.expiresAtMs);
      return ownerUserId;
    } catch {
      const refreshedUserId = readExplicitAccountStatus().userId;
      if (refreshedUserId !== accountAuthorizationUserId) applyExplicitAccountUserId(refreshedUserId);
      return refreshedUserId === ownerUserId
        && accountAuthorizationContinuityUserId === ownerUserId
        && Date.now() <= accountAuthorizationContinuityUntilMs
        ? ownerUserId
        : null;
    }
  };
  const captureAccountAuthorization = async (): Promise<{
    userId: string;
    generation: number;
  } | null> => {
    const userId = await getAccountLeaseUserId();
    return userId ? { userId, generation: accountAuthorizationGeneration } : null;
  };
  const verifyRelayAccountProof = async (
    token: string | null | undefined,
  ): Promise<VerifiedAccountAttestation | null> => {
    const before = await captureAccountAuthorization();
    const relayAccountToken = token?.trim() ?? "";
    if (!before || !relayAccountToken) return null;
    try {
      const attestation = await verifyAccountAttestation({
        token: relayAccountToken,
        expectedUserId: before.userId,
        config: getAccountAttestationConfig(),
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
  // Same machine-level security posture file the project sync host reads, so
  // `requireDpop` binds on this ingress path too — the brain is the default
  // sync host and must not be a softer entry point than the project host.
  const securityStore = createSyncSecurityStore({
    filePath: path.join(path.dirname(args.pinPath), "sync-security.json"),
  });
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
        verifyAccountToken: (token, expectedUserId) => verifyAccountAttestation({
          token,
          expectedUserId,
          config: getAccountAttestationConfig(),
        }),
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
          const currentOwner = await getAccountLeaseUserId();
          if (!isPeerCurrent(lifecycleGeneration)) return;
          if (currentOwner !== expectedOwner) {
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
          const authFailure = {
            code: "auth_failed" as "auth_failed" | "relay_account_required",
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
              if (!pairingStore.authenticate(auth.deviceId, auth.secret)) return true;
              authenticatedPairingRecord = pairingStore.getPairingRecord(auth.deviceId);
              if (!authenticatedPairingRecord) return true;
              const pairingOwner = optionalString(authenticatedPairingRecord.accountOwnerUserId);
              if (pairingOwner) {
                const currentOwner = await getAccountLeaseUserId();
                if (!isPeerCurrent(lifecycleGeneration)) return true;
                if (currentOwner !== pairingOwner) {
                  pairingStore.revokeAccountOwnedExcept(currentOwner);
                  return true;
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
            // Account hellos are authenticated only by the project sync host,
            // which owns the account session/config dependencies. The fallback
            // brain handler must reject them rather than treating them as a
            // bootstrap-shaped hello.
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
              message: authFailure.code === "relay_account_required"
                ? "Sign in with the same ADE account on both machines."
                : "Sync authentication failed.",
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
          peer.authKind = auth?.kind === "bootstrap" || auth?.kind === "paired"
            ? auth.kind
            : null;
          clearAuthTimeout();
          peer.metadata = hello.peer;
          peer.pairingRecord = auth?.kind === "paired" ? authenticatedPairingRecord : null;
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
            // Advertise the runtime RPC channel + port-forward only to paired
            // desktop runtime-hosts (phones/browsers stay on the allowlist).
            runtimeChannelEnabled:
              auth?.kind === "paired" && isRuntimeHostPairingRecord(authenticatedPairingRecord),
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
