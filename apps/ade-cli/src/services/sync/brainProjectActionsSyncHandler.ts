import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RawData, WebSocket } from "ws";
import type {
  AgentChatEventEnvelope,
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ProjectBrowseInput,
  PersonalChatScopeContract,
  SyncChatSubscribePayload,
  SyncChatSubscribeSnapshotPayload,
  SyncChatUnsubscribePayload,
  SyncCommandPayload,
  SyncRemoteCommandDescriptor,
  SyncEnvelope,
  SyncHelloPayload,
  SyncMobileProjectSummary,
  SyncPairingRequestPayload,
  SyncPeerMetadata,
  SyncProjectForgetRequestPayload,
  SyncProjectForgetResultPayload,
  SyncProjectCatalogPayload,
  SyncProjectOpenRequestPayload,
  SyncProjectSwitchRequestPayload,
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
  createSyncPairedChannelService,
  isPairedRuntimeEnvelopeType,
} from "./syncPairedChannelService";
import { createSyncPinStore } from "./syncPinStore";
import { createSyncSecurityStore } from "./syncSecurityStore";
import {
  DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
  encodeSyncEnvelope,
  mapPlatform,
  parseSyncEnvelope,
  wsDataToText,
} from "./syncProtocol";
import {
  buildSyncHostHelloOkPayload,
  buildSyncProjectCatalogMessages,
  isRuntimeHostPairingRecord,
  type SyncProjectCatalogProvider,
} from "./syncHostService";
import { resolveDeviceDisplayName } from "./deviceRegistryService";

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
  personalChatScope?: PersonalChatScopeContract;
};

type BrainPeerState = {
  ws: WebSocket;
  authenticated: boolean;
  authKind: "bootstrap" | "paired" | null;
  authTimeout: ReturnType<typeof setTimeout> | null;
  metadata: SyncPeerMetadata | null;
  personalChatSubscriptions: Map<string, { transcriptPath: string; offset: number }>;
  pairingRecord: SyncPairingRecord | null;
};

const WS_OPEN = 1;
const BOOTSTRAP_TOKEN_KEY = "sync.bootstrapToken.v1";
const PAIR_FAILURE_THRESHOLD = 5;
const PAIR_COOLDOWN_MS = 10 * 60_000;
const PAIR_FAILURE_WINDOW_MS = 10 * 60_000;
const BRAIN_SYNC_AUTH_TIMEOUT_MS = 15_000;

type PairFailureEntry = {
  count: number;
  cooldownUntilMs: number;
  updatedAtMs: number;
};

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
  const auth = record.auth as SyncHelloPayload["auth"] | undefined;
  if (auth?.kind === "bootstrap" && optionalString(auth.token)) {
    return { peer, auth: { kind: "bootstrap", token: auth.token } };
  }
  if (
    auth?.kind === "paired"
    && optionalString(auth.deviceId)
    && optionalString(auth.secret)
  ) {
    return {
      peer,
      auth: {
        kind: "paired",
        deviceId: auth.deviceId,
        secret: auth.secret,
        ...(auth.dpop ? { dpop: auth.dpop } : {}),
      },
    };
  }
  const token = optionalString(record.token);
  if (token) return { peer, auth: { kind: "bootstrap", token } };
  return null;
}

function parsePairingRequestPayload(payload: unknown): SyncPairingRequestPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const code = optionalString(record.code);
  const peer = normalizePeerMetadata(record.peer);
  const dpopPublicKey = optionalString(record.dpopPublicKey);
  return code && peer ? { code, peer, ...(dpopPublicKey ? { dpopPublicKey } : {}) } : null;
}

function send(
  ws: WebSocket,
  type: SyncEnvelope["type"],
  payload: unknown,
  requestId?: string | null,
): boolean {
  if (ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(encodeSyncEnvelope({
      type,
      requestId,
      payload,
      compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
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

function createPairFailureTracker() {
  const pairFailures = new Map<string, PairFailureEntry>();
  const globalPairFailures: PairFailureEntry = {
    count: 0,
    cooldownUntilMs: 0,
    updatedAtMs: 0,
  };

  const reset = (entry: PairFailureEntry): void => {
    entry.count = 0;
    entry.cooldownUntilMs = 0;
    entry.updatedAtMs = 0;
  };
  const expired = (entry: PairFailureEntry, now: number): boolean => {
    if (entry.updatedAtMs <= 0) return false;
    return (entry.cooldownUntilMs > 0 && entry.cooldownUntilMs <= now)
      || entry.updatedAtMs + PAIR_FAILURE_WINDOW_MS <= now;
  };
  const prune = (now = Date.now()): void => {
    for (const [ip, entry] of pairFailures) {
      if (expired(entry, now)) {
        pairFailures.delete(ip);
      }
    }
    if (expired(globalPairFailures, now)) {
      reset(globalPairFailures);
    }
  };
  const increment = (entry: PairFailureEntry, now: number): void => {
    entry.count += 1;
    entry.updatedAtMs = now;
    if (entry.count >= PAIR_FAILURE_THRESHOLD) {
      entry.cooldownUntilMs = now + PAIR_COOLDOWN_MS;
      entry.count = 0;
    }
  };

  return {
    cooldownMsRemaining(ip: string | null): number {
      const now = Date.now();
      prune(now);
      const globalRemaining = Math.max(0, globalPairFailures.cooldownUntilMs - now);
      const ipEntry = ip ? pairFailures.get(ip) ?? null : null;
      const ipRemaining = ipEntry ? Math.max(0, ipEntry.cooldownUntilMs - now) : 0;
      return Math.max(globalRemaining, ipRemaining);
    },
    registerFailure(ip: string | null): void {
      const now = Date.now();
      prune(now);
      increment(globalPairFailures, now);
      if (ip) {
        const entry = pairFailures.get(ip) ?? {
          count: 0,
          cooldownUntilMs: 0,
          updatedAtMs: now,
        };
        increment(entry, now);
        pairFailures.set(ip, entry);
      }
    },
    clearAfterSuccess(ip: string | null): void {
      reset(globalPairFailures);
      if (ip) pairFailures.delete(ip);
    },
  };
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
  // Same machine-level security posture file the project sync host reads, so
  // `requireDpop` binds on this ingress path too — the brain is the default
  // sync host and must not be a softer entry point than the project host.
  const securityStore = createSyncSecurityStore({
    filePath: path.join(path.dirname(args.pinPath), "sync-security.json"),
  });
  const localDeviceId = ensureSecretFile(args.localDeviceIdPath, 16);
  const localSiteId = ensureSecretFile(args.localSiteIdPath, 16);
  const heartbeatIntervalMs = Math.max(5_000, Math.floor(args.heartbeatIntervalMs ?? 5_000));
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
  ): Promise<void> => {
    if (!action) {
      send(peer.ws, resultType, { ok: false, message: unavailableMessage }, requestId);
      return;
    }
    try {
      const project = await action(payload);
      send(peer.ws, resultType, { ok: true, project }, requestId);
      sendProjectCatalog(peer.ws, await projectCatalog(args.projectCatalogProvider, args.logger));
    } catch (error) {
      send(peer.ws, resultType, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }, requestId);
    }
  };

  const handleAuthenticatedEnvelope = async (peer: BrainPeerState, envelope: ReturnType<typeof parseSyncEnvelope>): Promise<void> => {
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
        sendProjectCatalog(peer.ws, await projectCatalog(args.projectCatalogProvider, args.logger), envelope.requestId);
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
          send(peer.ws, "project_switch_result", result, envelope.requestId);
          resultSent = true;
          completionAttempted = true;
          await args.projectCatalogProvider.completeProjectConnection?.(
            (envelope.payload ?? {}) as SyncProjectSwitchRequestPayload,
            result,
          );
        } catch (error) {
          args.logger.warn("sync_brain.project_switch_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          if (result && !completionAttempted) {
            try {
              await args.projectCatalogProvider.completeProjectConnection?.(
                (envelope.payload ?? {}) as SyncProjectSwitchRequestPayload,
                result,
              );
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
          send(peer.ws, "project_forget_result", result, envelope.requestId);
          if (result.ok) {
            sendProjectCatalog(peer.ws, await projectCatalog(args.projectCatalogProvider, args.logger));
          }
        } catch (error) {
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
          send(peer.ws, "project_browse_result", result
            ? { ok: true, result }
            : { ok: false, message: "Project browsing is not available from this machine." }, envelope.requestId);
        } catch (error) {
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
          send(peer.ws, "project_default_parent_dir", parentDir
            ? { ok: true, parentDir }
            : { ok: false, message: "Default project directory is not available from this machine." }, envelope.requestId);
        } catch (error) {
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
        );
        break;
      }
      case "project_list_my_github_repos_request": {
        try {
          const result = await args.projectCatalogProvider.listMyGitHubRepos?.(
            (envelope.payload ?? {}) as ListMyGitHubReposInput,
          );
          send(peer.ws, "project_list_my_github_repos_result", result
            ? { ok: true, result }
            : { ok: false, message: "GitHub repository listing is not available from this machine." }, envelope.requestId);
        } catch (error) {
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
          : 2_000_000;
        // Capture the tail point before reading history. Events committed
        // during the snapshot can then be replayed (and client-deduped), but
        // can never fall into the gap between history collection and offset.
        const offset = await fs.promises.stat(transcriptPath)
          .then((stat) => stat.size)
          .catch(() => 0);
        const history = (await args.personalChatScope.call("getEventHistory", {
          sessionId,
          maxBytes,
        })).result as { events?: AgentChatEventEnvelope[]; truncated?: boolean };
        peer.personalChatSubscriptions.set(sessionId, { transcriptPath, offset });
        send(peer.ws, "chat_subscribe", {
          sessionId,
          capturedAt: nowIso(),
          truncated: history.truncated === true,
          events: history.events ?? [],
          turnActive: await args.personalChatScope.isTurnActive(sessionId),
        } satisfies SyncChatSubscribeSnapshotPayload, envelope.requestId);
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
            send(peer.ws, "command_result", { commandId, ok: true, result }, envelope.requestId);
          } catch (error) {
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

  return ({ ws, remoteAddress }) => {
    const peer: BrainPeerState = {
      ws,
      authenticated: false,
      authKind: null,
      authTimeout: null,
      metadata: null,
      personalChatSubscriptions: new Map(),
      pairingRecord: null,
    };
    let personalChatPumpRunning = false;
    const personalChatPump = setInterval(() => {
      if (!peer.authenticated || peer.ws.readyState !== WS_OPEN || personalChatPumpRunning) return;
      personalChatPumpRunning = true;
      void (async () => {
        for (const [sessionId, subscription] of peer.personalChatSubscriptions) {
          const next = await readPersonalChatEventsSince(subscription.transcriptPath, subscription.offset);
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
      void (async () => {
        let envelope: ReturnType<typeof parseSyncEnvelope>;
        try {
          envelope = parseSyncEnvelope(wsDataToText(data));
        } catch (error) {
          args.logger.warn("sync_brain.invalid_envelope", {
            error: error instanceof Error ? error.message : String(error),
            remoteAddress: remoteAddress ?? null,
          });
          return;
        }

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
            const cooldownMs = pairFailures.cooldownMsRemaining(remoteAddress ?? null);
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
              });
              pairFailures.clearAfterSuccess(remoteAddress ?? null);
              send(ws, "pairing_result", { ok: true, deviceId: paired.deviceId, secret: paired.secret }, envelope.requestId);
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
                pairFailures.registerFailure(remoteAddress ?? null);
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
          const authFailed = (() => {
            if (auth?.kind === "paired") {
              if (auth.deviceId !== hello.peer.deviceId) return true;
              if (!pairingStore.authenticate(auth.deviceId, auth.secret)) return true;
              authenticatedPairingRecord = pairingStore.getPairingRecord(auth.deviceId);
              if (!authenticatedPairingRecord) return true;
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
            if (!auth || !safeStringEquals(bootstrapToken, auth.token)) return true;
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
          if (authFailed) {
            // Same attribution as the project host's auth_failed: name the
            // rejecting machine so clients never drop a saved pairing over a
            // rejection they cannot attribute to the paired machine.
            const rejectingHost = brainMetadata();
            send(ws, "hello_error", {
              code: "auth_failed",
              message: "Sync authentication failed.",
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
          peer.authKind = auth?.kind ?? null;
          clearAuthTimeout();
          peer.metadata = hello.peer;
          peer.pairingRecord = auth?.kind === "paired" ? authenticatedPairingRecord : null;
          const catalog = await projectCatalog(args.projectCatalogProvider, args.logger);
          const brain = brainMetadata();
          const personalDescriptors = personalChatCommandDescriptors(args.personalChatScope);
          send(ws, "hello_ok", buildSyncHostHelloOkPayload({
            peer: hello.peer,
            brain,
            serverDbVersion: 0,
            heartbeatIntervalMs,
            pollIntervalMs,
            projectCatalog: catalog,
            projectCatalogEnabled: true,
            crossProjectChatEnabled: false,
            projectActionsEnabled: projectActionsEnabled(args.projectCatalogProvider),
            remoteCommandSupportedActions: personalDescriptors.map((entry) => entry.action),
            remoteCommandDescriptors: personalDescriptors,
            localCommandDescriptors: [],
            compressionThresholdBytes: DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES,
            cloudRelayWssUrl: args.getCloudRelayWssUrl?.() ?? null,
            // Advertise the runtime RPC channel + port-forward only to paired
            // desktop runtime-hosts (phones/browsers stay on the allowlist).
            runtimeChannelEnabled:
              auth?.kind === "paired" && isRuntimeHostPairingRecord(authenticatedPairingRecord),
          }), envelope.requestId);
          return;
        }

        await handleAuthenticatedEnvelope(peer, envelope);
      })().catch((error) => {
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
    ws.on("close", () => {
      clearAuthTimeout();
      clearInterval(personalChatPump);
      peer.personalChatSubscriptions.clear();
      pairedChannelService.closePeer(ws, "Sync socket closed.", false);
    });
  };
}
