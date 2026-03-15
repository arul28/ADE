import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  CrsqlChangeRow,
  FileContent,
  FileTreeNode,
  FilesQuickOpenItem,
  FilesSearchTextMatch,
  FilesWorkspace,
  PtyDataEvent,
  PtyExitEvent,
  SyncBrainStatusPayload,
  SyncChangesetBatchPayload,
  SyncCommandPayload,
  SyncCommandResultPayload,
  SyncEnvelope,
  SyncFileBlob,
  SyncFileRequest,
  SyncFileResponsePayload,
  SyncHelloPayload,
  SyncPeerConnectionState,
  SyncPeerMetadata,
  SyncRunQuickCommandArgs,
  SyncTerminalSnapshotPayload,
  TerminalToolType,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createFileService } from "../files/fileService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import type { createComputerUseArtifactBrokerService } from "../computerUse/computerUseArtifactBrokerService";
import type { AdeDb } from "../state/kvDb";
import { hasNullByte, isWithinDir, normalizeRelative, nowIso, toOptionalString } from "../shared/utils";
import type { DeviceRegistryService } from "./deviceRegistryService";
import { DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES, DEFAULT_SYNC_HOST_PORT, encodeSyncEnvelope, mapPlatform, parseSyncEnvelope, wsDataToText } from "./syncProtocol";
const DEFAULT_SYNC_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SYNC_POLL_INTERVAL_MS = 400;
const DEFAULT_BRAIN_STATUS_INTERVAL_MS = 5_000;
const DEFAULT_TERMINAL_SNAPSHOT_BYTES = 220_000;

type PeerState = {
  ws: WebSocket;
  metadata: SyncPeerMetadata | null;
  authenticated: boolean;
  connectedAt: string;
  lastSeenAt: string;
  lastAppliedAt: string | null;
  lastKnownServerDbVersion: number;
  latencyMs: number | null;
  awaitingHeartbeatAt: string | null;
  remoteAddress: string | null;
  remotePort: number | null;
  subscribedSessionIds: Set<string>;
};

type SyncHostServiceArgs = {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  fileService: ReturnType<typeof createFileService>;
  sessionService: ReturnType<typeof createSessionService>;
  ptyService: ReturnType<typeof createPtyService>;
  computerUseArtifactBrokerService: ReturnType<typeof createComputerUseArtifactBrokerService>;
  bootstrapTokenPath?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  brainStatusIntervalMs?: number;
  compressionThresholdBytes?: number;
  deviceRegistryService?: DeviceRegistryService;
  onStateChanged?: () => void;
};

function sanitizeRemoteAddress(remoteAddress: string | null | undefined): string | null {
  const value = toOptionalString(remoteAddress);
  if (!value) return null;
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function normalizeToolType(raw: string | null | undefined): TerminalToolType | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) return null;
  const allowed: TerminalToolType[] = [
    "shell",
    "run-shell",
    "claude",
    "codex",
    "claude-orchestrated",
    "codex-orchestrated",
    "ai-orchestrated",
    "codex-chat",
    "claude-chat",
    "ai-chat",
    "cursor",
    "aider",
    "continue",
    "other",
  ];
  return (allowed as string[]).includes(value) ? (value as TerminalToolType) : "other";
}

function ensureBootstrapToken(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, randomBytes(24).toString("hex"), "utf8");
  }
  return fs.readFileSync(filePath, "utf8").trim();
}

function inferMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".zip":
      return "application/zip";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return null;
  }
}

function fileContentToBlob(filePath: string, content: FileContent): SyncFileBlob {
  return {
    path: filePath,
    size: content.size,
    mimeType: inferMimeType(filePath),
    encoding: "utf-8",
    isBinary: content.isBinary,
    content: content.content,
    languageId: content.languageId,
  };
}

function createBlobFromBuffer(filePath: string, buf: Buffer): SyncFileBlob {
  const isBinary = hasNullByte(buf);
  return {
    path: filePath,
    size: buf.length,
    mimeType: inferMimeType(filePath),
    encoding: isBinary ? "base64" : "utf-8",
    isBinary,
    content: isBinary ? buf.toString("base64") : buf.toString("utf8"),
    languageId: null,
  };
}

function toSyncPeerConnectionState(peer: PeerState, currentServerDbVersion: number): SyncPeerConnectionState | null {
  if (!peer.metadata) return null;
  return {
    ...peer.metadata,
    connectedAt: peer.connectedAt,
    lastSeenAt: peer.lastSeenAt,
    lastAppliedAt: peer.lastAppliedAt,
    remoteAddress: peer.remoteAddress,
    remotePort: peer.remotePort,
    latencyMs: peer.latencyMs,
    syncLag: Math.max(0, currentServerDbVersion - peer.lastKnownServerDbVersion),
    isBrain: false,
    isAuthenticated: peer.authenticated,
  };
}

function parseHelloPayload(payload: unknown): SyncHelloPayload | null {
  const value = payload as SyncHelloPayload | null;
  const token = toOptionalString(value?.token);
  const peer = value?.peer;
  if (!token || !peer || typeof peer !== "object") return null;
  if (!toOptionalString(peer.deviceId) || !toOptionalString(peer.deviceName) || !toOptionalString(peer.siteId)) {
    return null;
  }
  return {
    token,
    peer: {
      deviceId: String(peer.deviceId).trim(),
      deviceName: String(peer.deviceName).trim(),
      platform: peer.platform ?? "unknown",
      deviceType: peer.deviceType ?? "unknown",
      siteId: String(peer.siteId).trim(),
      dbVersion: Number(peer.dbVersion ?? 0),
    },
  };
}

function parseQuickCommandArgs(value: Record<string, unknown>): SyncRunQuickCommandArgs | null {
  const laneId = toOptionalString(value.laneId);
  const title = toOptionalString(value.title);
  const startupCommand = toOptionalString(value.startupCommand);
  if (!laneId || !title || !startupCommand) return null;
  return {
    laneId,
    title,
    startupCommand,
    cols: Number.isFinite(value.cols) ? Number(value.cols) : undefined,
    rows: Number.isFinite(value.rows) ? Number(value.rows) : undefined,
    toolType: toOptionalString(value.toolType),
  };
}

export function createSyncHostService(args: SyncHostServiceArgs) {
  const layout = resolveAdeLayout(args.projectRoot);
  const bootstrapTokenPath = args.bootstrapTokenPath ?? path.join(layout.secretsDir, "sync-bootstrap-token");
  const bootstrapToken = ensureBootstrapToken(bootstrapTokenPath);
  const heartbeatIntervalMs = Math.max(5_000, Math.floor(args.heartbeatIntervalMs ?? DEFAULT_SYNC_HEARTBEAT_INTERVAL_MS));
  const pollIntervalMs = Math.max(100, Math.floor(args.pollIntervalMs ?? DEFAULT_SYNC_POLL_INTERVAL_MS));
  const brainStatusIntervalMs = Math.max(1_000, Math.floor(args.brainStatusIntervalMs ?? DEFAULT_BRAIN_STATUS_INTERVAL_MS));
  const compressionThresholdBytes = Math.max(256, Math.floor(args.compressionThresholdBytes ?? DEFAULT_SYNC_COMPRESSION_THRESHOLD_BYTES));

  const readBrainMetadata = (): SyncPeerMetadata => {
    const localDevice = args.deviceRegistryService?.ensureLocalDevice();
    return {
      deviceId: localDevice?.deviceId ?? args.db.sync.getSiteId(),
      deviceName: localDevice?.name ?? os.hostname(),
      platform: localDevice?.platform ?? mapPlatform(process.platform),
      deviceType: localDevice?.deviceType ?? "desktop",
      siteId: localDevice?.siteId ?? args.db.sync.getSiteId(),
      dbVersion: args.db.sync.getDbVersion(),
    };
  };

  const peers = new Set<PeerState>();
  const server = new WebSocketServer({
    host: "0.0.0.0",
    port: args.port ?? DEFAULT_SYNC_HOST_PORT,
    maxPayload: 25 * 1024 * 1024,
  });

  let disposed = false;
  let lastBroadcastAt: string | null = null;
  const startedAtMs = Date.now();
  const pollTimer = setInterval(() => {
    void pumpChanges().catch((error) => {
      args.logger.warn("sync_host.poll_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, pollIntervalMs);
  const heartbeatTimer = setInterval(() => {
    const sentAt = nowIso();
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (peer.awaitingHeartbeatAt) {
        try {
          peer.ws.close(4001, "Heartbeat timed out");
        } catch {
          // ignore
        }
        continue;
      }
      peer.awaitingHeartbeatAt = sentAt;
      send(peer.ws, "heartbeat", { kind: "ping", sentAt, dbVersion: args.db.sync.getDbVersion() });
    }
  }, heartbeatIntervalMs);
  const brainStatusTimer = setInterval(() => {
    broadcastBrainStatus();
  }, brainStatusIntervalMs);

  server.on("connection", (ws, request) => {
    const peer: PeerState = {
      ws,
      metadata: null,
      authenticated: false,
      connectedAt: nowIso(),
      lastSeenAt: nowIso(),
      lastAppliedAt: null,
      lastKnownServerDbVersion: 0,
      latencyMs: null,
      awaitingHeartbeatAt: null,
      remoteAddress: sanitizeRemoteAddress(request.socket.remoteAddress),
      remotePort: request.socket.remotePort ?? null,
      subscribedSessionIds: new Set(),
    };
    peers.add(peer);
    ws.on("message", (raw) => {
      void handleMessage(peer, raw).catch((error) => {
        args.logger.warn("sync_host.message_failed", {
          error: error instanceof Error ? error.message : String(error),
          peerDeviceId: peer.metadata?.deviceId ?? null,
        });
      });
    });
    ws.on("close", () => {
      peers.delete(peer);
      args.onStateChanged?.();
      broadcastBrainStatus();
    });
    ws.on("error", (error) => {
      args.logger.warn("sync_host.socket_error", {
        error: error instanceof Error ? error.message : String(error),
        peerDeviceId: peer.metadata?.deviceId ?? null,
      });
    });
  });

  function send<TPayload>(ws: WebSocket, type: SyncEnvelope["type"], payload: TPayload, requestId?: string | null): void {
    ws.send(encodeSyncEnvelope({ type, payload, requestId, compressionThresholdBytes }));
  }

  function buildBrainStatus(): SyncBrainStatusPayload {
    const brainMetadata = readBrainMetadata();
    if (disposed) {
      return {
        brain: brainMetadata,
        connectedPeers: [],
        metrics: {
          connectedPeerCount: 0,
          runningSessionCount: 0,
          dbVersion: brainMetadata.dbVersion,
          uptimeMs: Date.now() - startedAtMs,
          lastBroadcastAt,
        },
      };
    }
    const dbVersion = args.db.sync.getDbVersion();
    const connectedPeers = [...peers]
      .map((peer) => toSyncPeerConnectionState(peer, dbVersion))
      .filter((peer): peer is SyncPeerConnectionState => peer != null);
    return {
      brain: {
        ...brainMetadata,
        dbVersion,
      },
      connectedPeers,
      metrics: {
        connectedPeerCount: connectedPeers.length,
        runningSessionCount: args.sessionService.list({ status: "running", limit: 200 }).length,
        dbVersion,
        uptimeMs: Date.now() - startedAtMs,
        lastBroadcastAt,
      },
    };
  }

  function broadcastBrainStatus(): void {
    if (disposed) return;
    const payload = buildBrainStatus();
    for (const peer of peers) {
      if (!peer.authenticated || peer.ws.readyState !== WebSocket.OPEN) continue;
      send(peer.ws, "brain_status", payload);
    }
  }

  async function pumpChanges(): Promise<void> {
    if (disposed) return;
    const currentDbVersion = args.db.sync.getDbVersion();
    for (const peer of peers) {
      if (!peer.authenticated || !peer.metadata || peer.ws.readyState !== WebSocket.OPEN) continue;
      if (currentDbVersion <= peer.lastKnownServerDbVersion) continue;
      const changes = args.db.sync
        .exportChangesSince(peer.lastKnownServerDbVersion)
        .filter((change: CrsqlChangeRow) => change.site_id !== peer.metadata?.siteId);
      if (changes.length > 0) {
        const payload: SyncChangesetBatchPayload = {
          reason: "broadcast",
          fromDbVersion: peer.lastKnownServerDbVersion,
          toDbVersion: currentDbVersion,
          changes,
        };
        send(peer.ws, "changeset_batch", payload);
        lastBroadcastAt = nowIso();
      }
      peer.lastKnownServerDbVersion = currentDbVersion;
    }
  }

  function resolveArtifactPath(request: Extract<SyncFileRequest, { action: "readArtifact" }>["args"]): string {
    const artifactId = toOptionalString(request.artifactId);
    const explicitUri = toOptionalString(request.uri) ?? toOptionalString(request.path);
    let candidate = explicitUri;
    if (artifactId) {
      const artifact = args.computerUseArtifactBrokerService.listArtifacts({ artifactId })[0] ?? null;
      candidate = artifact?.uri ?? candidate;
    }
    if (!candidate) {
      throw new Error("Artifact request requires artifactId, uri, or path.");
    }
    if (/^https?:\/\//i.test(candidate)) {
      throw new Error("Remote artifact URLs are not supported by the desktop sync host.");
    }
    const absolute = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(args.projectRoot, candidate);
    if (!isWithinDir(layout.artifactsDir, absolute)) {
      throw new Error("Artifact path must resolve within .ade/artifacts.");
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error("Artifact file does not exist.");
    }
    return absolute;
  }

  async function handleFileRequest(peer: PeerState, requestId: string | null, payload: SyncFileRequest): Promise<void> {
    const respond = (response: SyncFileResponsePayload) => {
      send(peer.ws, "file_response", response, requestId);
    };

    try {
      let result:
        | FilesWorkspace[]
        | FileTreeNode[]
        | FileContent
        | FilesQuickOpenItem[]
        | FilesSearchTextMatch[]
        | SyncFileBlob
        | { ok: true } = { ok: true };

      switch (payload.action) {
        case "listWorkspaces":
          result = args.fileService.listWorkspaces(payload.args ?? {});
          break;
        case "listTree":
          result = await args.fileService.listTree(payload.args);
          break;
        case "readFile":
          result = fileContentToBlob(payload.args.path, args.fileService.readFile(payload.args));
          break;
        case "writeText":
          args.fileService.writeWorkspaceText(payload.args);
          result = { ok: true };
          break;
        case "createFile":
          args.fileService.createFile(payload.args);
          result = { ok: true };
          break;
        case "createDirectory":
          args.fileService.createDirectory(payload.args);
          result = { ok: true };
          break;
        case "rename":
          args.fileService.rename(payload.args);
          result = { ok: true };
          break;
        case "deletePath":
          args.fileService.deletePath(payload.args);
          result = { ok: true };
          break;
        case "quickOpen":
          result = await args.fileService.quickOpen(payload.args);
          break;
        case "searchText":
          result = await args.fileService.searchText(payload.args);
          break;
        case "readArtifact": {
          const artifactPath = resolveArtifactPath(payload.args);
          result = createBlobFromBuffer(normalizeRelative(path.relative(args.projectRoot, artifactPath)), fs.readFileSync(artifactPath));
          break;
        }
        default:
          throw new Error(`Unsupported file action: ${(payload as { action?: string }).action ?? "unknown"}`);
      }

      respond({
        ok: true,
        action: payload.action,
        result,
      });
    } catch (error) {
      respond({
        ok: false,
        action: payload.action,
        error: {
          code: "file_request_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async function handleCommand(peer: PeerState, requestId: string | null, payload: SyncCommandPayload): Promise<void> {
    const commandId = toOptionalString(payload.commandId) ?? requestId ?? `cmd-${Date.now()}`;
    const reject = (message: string, code = "unsupported_command") => {
      send(peer.ws, "command_ack", {
        commandId,
        accepted: false,
        status: "rejected",
        message,
      }, requestId);
      const result: SyncCommandResultPayload = {
        commandId,
        ok: false,
        error: {
          code,
          message,
        },
      };
      send(peer.ws, "command_result", result, requestId);
    };

    if (payload.action !== "work.runQuickCommand") {
      reject(`Command ${payload.action} is reserved for future W10 work; only work.runQuickCommand is enabled in W2.`);
      return;
    }

    const parsedArgs = parseQuickCommandArgs(payload.args);
    if (!parsedArgs) {
      reject("work.runQuickCommand requires laneId, title, and startupCommand.", "invalid_command");
      return;
    }

    send(peer.ws, "command_ack", {
      commandId,
      accepted: true,
      status: "accepted",
      message: "Launching remote terminal session.",
    }, requestId);

    try {
      const created = await args.ptyService.create({
        laneId: parsedArgs.laneId,
        title: parsedArgs.title,
        startupCommand: parsedArgs.startupCommand,
        tracked: true,
        cols: parsedArgs.cols ?? 120,
        rows: parsedArgs.rows ?? 36,
        toolType: normalizeToolType(parsedArgs.toolType) ?? "run-shell",
      });
      send(peer.ws, "command_result", {
        commandId,
        ok: true,
        result: created,
      }, requestId);
    } catch (error) {
      send(peer.ws, "command_result", {
        commandId,
        ok: false,
        error: {
          code: "command_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }, requestId);
    }
  }

  async function handleMessage(peer: PeerState, raw: RawData): Promise<void> {
    const rawText = wsDataToText(raw);
    const envelope = parseSyncEnvelope(rawText);
    peer.lastSeenAt = nowIso();

    if (!peer.authenticated) {
      if (envelope.type !== "hello") {
        send(peer.ws, "hello_error", {
          code: "invalid_hello",
          message: "Authenticate with a hello envelope before sending other messages.",
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication required");
        } catch {
          // ignore
        }
        return;
      }
      const hello = parseHelloPayload(envelope.payload);
      if (!hello || hello.token !== bootstrapToken) {
        send(peer.ws, "hello_error", {
          code: "auth_failed",
          message: "Bootstrap token authentication failed.",
        }, envelope.requestId);
        try {
          peer.ws.close(4003, "Authentication failed");
        } catch {
          // ignore
        }
        return;
      }

      peer.authenticated = true;
      peer.metadata = hello.peer;
      peer.lastKnownServerDbVersion = Math.max(0, Math.floor(hello.peer.dbVersion));
      args.deviceRegistryService?.upsertPeerMetadata(hello.peer, {
        lastSeenAt: nowIso(),
        lastHost: peer.remoteAddress,
        lastPort: peer.remotePort,
      });
      send(peer.ws, "hello_ok", {
        peer: hello.peer,
        brain: readBrainMetadata(),
        serverDbVersion: args.db.sync.getDbVersion(),
        heartbeatIntervalMs,
        pollIntervalMs,
        features: {
          fileAccess: true,
          terminalStreaming: true,
          bootstrapAuth: true,
          commandRouting: {
            mode: "minimal",
            supportedActions: ["work.runQuickCommand"],
          },
        },
      }, envelope.requestId);
      args.onStateChanged?.();
      await pumpChanges();
      broadcastBrainStatus();
      return;
    }

    switch (envelope.type) {
      case "heartbeat": {
        const payload = envelope.payload as { kind?: string; sentAt?: string } | null;
        if (payload?.kind === "ping") {
          send(peer.ws, "heartbeat", {
            kind: "pong",
            sentAt: payload.sentAt ?? nowIso(),
            dbVersion: args.db.sync.getDbVersion(),
          }, envelope.requestId);
        } else if (payload?.kind === "pong" && peer.awaitingHeartbeatAt) {
          const now = Date.now();
          const sentAtMs = Date.parse(peer.awaitingHeartbeatAt);
          peer.latencyMs = Number.isFinite(sentAtMs) ? Math.max(0, now - sentAtMs) : null;
          peer.awaitingHeartbeatAt = null;
        }
        break;
      }
      case "changeset_batch": {
        const payload = (envelope.payload ?? {}) as SyncChangesetBatchPayload;
        const changes = Array.isArray(payload.changes) ? payload.changes as CrsqlChangeRow[] : [];
        if (changes.length > 0) {
          args.db.sync.applyChanges(changes);
          peer.lastAppliedAt = nowIso();
          lastBroadcastAt = nowIso();
          args.onStateChanged?.();
          broadcastBrainStatus();
        }
        break;
      }
      case "file_request":
        await handleFileRequest(peer, envelope.requestId, envelope.payload as SyncFileRequest);
        break;
      case "terminal_subscribe": {
        const payload = envelope.payload as { sessionId?: string; maxBytes?: number } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (!sessionId) break;
        peer.subscribedSessionIds.add(sessionId);
        const session = args.sessionService.get(sessionId);
        const transcript = session
          ? await args.sessionService.readTranscriptTail(
              session.transcriptPath,
              Math.max(1_024, Math.min(2_000_000, Math.floor(payload?.maxBytes ?? DEFAULT_TERMINAL_SNAPSHOT_BYTES))),
              { raw: true, alignToLineBoundary: true },
            )
          : "";
        const snapshot: SyncTerminalSnapshotPayload = {
          sessionId,
          transcript,
          status: session?.status ?? null,
          runtimeState: session?.runtimeState ?? null,
          lastOutputPreview: session?.lastOutputPreview ?? null,
          capturedAt: nowIso(),
        };
        send(peer.ws, "terminal_snapshot", snapshot, envelope.requestId);
        break;
      }
      case "terminal_unsubscribe": {
        const payload = envelope.payload as { sessionId?: string } | null;
        const sessionId = toOptionalString(payload?.sessionId);
        if (sessionId) {
          peer.subscribedSessionIds.delete(sessionId);
        }
        break;
      }
      case "command":
        await handleCommand(peer, envelope.requestId, envelope.payload as SyncCommandPayload);
        break;
      default:
        break;
    }
  }

  return {
    async waitUntilListening(): Promise<number> {
      if (server.address()) {
        const address = server.address();
        return typeof address === "object" && address ? address.port : DEFAULT_SYNC_HOST_PORT;
      }
      await new Promise<void>((resolve) => {
        server.once("listening", () => resolve());
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : DEFAULT_SYNC_HOST_PORT;
    },

    getPort(): number | null {
      const address = server.address();
      return typeof address === "object" && address ? address.port : null;
    },

    getBootstrapToken(): string {
      return bootstrapToken;
    },

    getPeerStates(): SyncPeerConnectionState[] {
      const dbVersion = args.db.sync.getDbVersion();
      return [...peers]
        .map((peer) => toSyncPeerConnectionState(peer, dbVersion))
        .filter((peer): peer is SyncPeerConnectionState => peer != null);
    },

    getBrainStatusSnapshot(): SyncBrainStatusPayload {
      return buildBrainStatus();
    },

    handlePtyData(event: PtyDataEvent): void {
      const payload = {
        sessionId: event.sessionId,
        ptyId: event.ptyId,
        data: event.data,
        at: nowIso(),
      };
      for (const peer of peers) {
        if (!peer.authenticated || !peer.subscribedSessionIds.has(event.sessionId) || peer.ws.readyState !== WebSocket.OPEN) continue;
        send(peer.ws, "terminal_data", payload);
      }
    },

    handlePtyExit(event: PtyExitEvent): void {
      const payload = {
        sessionId: event.sessionId,
        ptyId: event.ptyId,
        exitCode: event.exitCode,
        at: nowIso(),
      };
      for (const peer of peers) {
        if (!peer.authenticated || !peer.subscribedSessionIds.has(event.sessionId) || peer.ws.readyState !== WebSocket.OPEN) continue;
        send(peer.ws, "terminal_exit", payload);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      clearInterval(brainStatusTimer);
      await new Promise<void>((resolve) => {
        for (const peer of peers) {
          try {
            peer.ws.close();
          } catch {
            // ignore
          }
        }
        server.close(() => resolve());
      });
    },
  };
}

export type SyncHostService = ReturnType<typeof createSyncHostService>;
