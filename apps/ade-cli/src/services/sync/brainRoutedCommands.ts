import type { WebSocket } from "ws";
import type {
  SyncCommandAckPayload,
  SyncCommandPayload,
  SyncCommandResultPayload,
  SyncEnvelope,
  SyncPeerMetadata,
  SyncRemoteCommandDescriptor,
} from "../../../../desktop/src/shared/types";
import type { SyncPairingRecord } from "./syncPairingStore";
import {
  commandErrorResult,
  evaluateRemoteCommandPolicy,
  remoteCommandArgsFingerprint,
} from "./syncRemoteCommandService";
import { ROSTER_DIRTYING_COMMAND_ACTIONS } from "./syncRosterFanout";

/**
 * Routes a `command` that names a registered project to that project's scope,
 * the brain-side twin of the project host's `remoteCommandExecutor`. Getting a
 * descriptor or executing may boot the project's runtime (never its sync
 * host), exactly as a routed command on a project host does.
 */
export type BrainProjectCommandRouter = {
  /** The registered project a command targets, or null when none matches. */
  resolveProjectId(target: { projectId?: string | null; projectRootPath?: string | null }): string | null;
  /**
   * Descriptors of the project actions a project runtime registers, to
   * advertise. Must not boot a project.
   */
  listDescriptors(): Promise<SyncRemoteCommandDescriptor[]>;
  getDescriptor(projectId: string, action: string): Promise<SyncRemoteCommandDescriptor | null>;
  execute(payload: SyncCommandPayload & { projectId: string }, context: { signal?: AbortSignal }): Promise<unknown>;
};

/** What routing needs from the handler's peer record. */
export type BrainRoutedCommandPeer = {
  ws: WebSocket;
  metadata: SyncPeerMetadata | null;
  pairingRecord: SyncPairingRecord | null;
};

type SendEnvelope = (
  ws: WebSocket,
  type: SyncEnvelope["type"],
  payload: unknown,
  requestId?: string | null,
) => boolean;

// Routed project commands this ingress cannot serve: live streams need a
// per-socket sink only a project host wires, and analytics consent is a
// project-host peer setting.
const UNROUTABLE_PROJECT_COMMAND_PREFIXES = ["macDesktop.", "appControl.", "analytics."];
const BRAIN_COMMAND_RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
const BRAIN_COMMAND_RESULT_CACHE_MAX_ENTRIES = 256;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type BrainCommandRecord<P extends BrainRoutedCommandPeer> = {
  action: string;
  argsFingerprint: string;
  ack: SyncCommandAckPayload;
  result: SyncCommandResultPayload | null;
  waiters: Array<{ peer: P; requestId: string | null | undefined }>;
  createdAtMs: number;
};

/**
 * `command` envelopes that name a registered project, for the brain's
 * projectless ingress: the project host's policy gate, args identity and error
 * mapping (`syncRemoteCommandService`), executed in that project's scope.
 */
export function createBrainRoutedCommandHandler<P extends BrainRoutedCommandPeer>(args: {
  router: BrainProjectCommandRouter | undefined;
  send: SendEnvelope;
  /** A successful command added or removed a roster-visible row. */
  onRosterDirty: () => void;
}) {
  const { router, send } = args;
  // Idempotency for routed commands, keyed like the project host's ledger:
  // a phone retrying a command id after a reconnect gets the first answer
  // instead of running `chat.send` twice. In memory only.
  const records = new Map<string, BrainCommandRecord<P>>();
  const pruneRecords = (): void => {
    const cutoff = Date.now() - BRAIN_COMMAND_RESULT_CACHE_TTL_MS;
    for (const [key, record] of records) {
      if (record.result && record.createdAtMs < cutoff) records.delete(key);
    }
    for (const [key, record] of records) {
      if (records.size <= BRAIN_COMMAND_RESULT_CACHE_MAX_ENTRIES) break;
      if (record.result) records.delete(key);
    }
  };

  return {
    /** Routable project descriptors to advertise to a roster socket. */
    async advertisedDescriptors(): Promise<SyncRemoteCommandDescriptor[]> {
      if (!router) return [];
      const seen = new Set<string>();
      const descriptors = await router.listDescriptors().catch(() => [] as SyncRemoteCommandDescriptor[]);
      return descriptors.filter((descriptor) => {
        const action = descriptor.action;
        if (seen.has(action)) return false;
        seen.add(action);
        return !action.startsWith("personalChats.")
          && !action.startsWith("lanes.presence.")
          && !UNROUTABLE_PROJECT_COMMAND_PREFIXES.some((prefix) => action.startsWith(prefix))
          && !descriptor.policy.localOnly
          && !descriptor.policy.requiresApproval;
      });
    },

    /** True when a command names a project this handler should route. */
    wantsCommand(payload: SyncCommandPayload | null, envelopeProjectId: string | null): boolean {
      return Boolean(router)
        && Boolean(
          optionalString(payload?.projectId)
          || envelopeProjectId
          || optionalString(payload?.projectRootPath),
        );
    },

    /**
     * Runs a `command` that names a registered project in that project, with
     * the project host's policy gate. Returns false when the command names no
     * project (the caller keeps its "no project host" answer).
     */
    async handle(
      peer: P,
      requestId: string | null | undefined,
      payload: SyncCommandPayload,
      envelopeProjectId: string | null,
      isCurrent: () => boolean,
    ): Promise<boolean> {
      if (!router) return false;
      const targetProjectId = optionalString(payload.projectId) ?? envelopeProjectId;
      const targetRootPath = optionalString(payload.projectRootPath);
      if (!targetProjectId && !targetRootPath) return false;
      const commandId = optionalString(payload.commandId) ?? optionalString(requestId) ?? `cmd-${Date.now()}`;
      const action = typeof payload.action === "string" ? payload.action : "";
      const reject = (message: string, code: string): void => {
        send(peer.ws, "command_ack", {
          commandId,
          accepted: false,
          status: "rejected",
          message,
        } satisfies SyncCommandAckPayload, requestId);
        send(peer.ws, "command_result", {
          commandId,
          ok: false,
          error: { code, message },
        } satisfies SyncCommandResultPayload, requestId);
      };
      const projectId = router.resolveProjectId({ projectId: targetProjectId, projectRootPath: targetRootPath });
      if (!projectId) {
        reject("This project is not on this ADE machine. Select the project again and retry.", "project_not_open");
        return true;
      }
      pruneRecords();
      const cacheKey = `${projectId}\u0000${peer.metadata?.deviceId ?? ""}\u0000${commandId}`;
      const argsFingerprint = remoteCommandArgsFingerprint(payload.args ?? {});
      const existing = records.get(cacheKey);
      if (existing) {
        if (existing.action !== action || existing.argsFingerprint !== argsFingerprint) {
          reject("A command with this id already exists for a different action or payload.", "duplicate_command_mismatch");
          return true;
        }
        send(peer.ws, "command_ack", existing.ack, requestId);
        if (existing.result) send(peer.ws, "command_result", existing.result, requestId);
        else existing.waiters.push({ peer, requestId });
        return true;
      }
      if (action === "lanes.presence.announce" || action === "lanes.presence.release") {
        reject("Lane presence is not available for a project that is not open in this phone sync host.", "project_not_open");
        return true;
      }
      if (UNROUTABLE_PROJECT_COMMAND_PREFIXES.some((prefix) => action.startsWith(prefix))) {
        reject(`Remote command ${action} needs this machine to host the project. Open the project and retry.`, "project_not_open");
        return true;
      }
      let descriptor: SyncRemoteCommandDescriptor | null;
      try {
        descriptor = await router.getDescriptor(projectId, action);
      } catch (error) {
        if (!isCurrent()) return true;
        reject(error instanceof Error ? error.message : String(error), "command_failed");
        return true;
      }
      if (!isCurrent()) return true;
      // The project host's gate. This ingress hosts no project of its own: the
      // one it resolved is its "host" project, and a project-scoped command
      // must still name it by id.
      const rejection = evaluateRemoteCommandPolicy({
        action,
        descriptor,
        peer,
        requestedProjectId: targetProjectId,
        hostProjectId: projectId,
      });
      if (rejection) {
        reject(rejection.message, rejection.code);
        return true;
      }
      const record: BrainCommandRecord<P> = {
        action,
        argsFingerprint,
        ack: { commandId, accepted: true, status: "accepted", message: `Executing ${action}.` },
        result: null,
        waiters: [{ peer, requestId }],
        createdAtMs: Date.now(),
      };
      records.set(cacheKey, record);
      send(peer.ws, "command_ack", record.ack, requestId);
      let result: SyncCommandResultPayload;
      try {
        const created = await router.execute({ ...payload, action, projectId }, {});
        result = { commandId, ok: true, result: created };
        if (ROSTER_DIRTYING_COMMAND_ACTIONS.has(action)) args.onRosterDirty();
      } catch (error) {
        result = commandErrorResult(commandId, error);
      }
      record.result = result;
      for (const waiter of record.waiters.splice(0)) {
        send(waiter.peer.ws, "command_result", result, waiter.requestId);
      }
      return true;
    },
  };
}
