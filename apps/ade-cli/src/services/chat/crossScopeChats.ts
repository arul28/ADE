/**
 * Chats talking across the walls of one chat service: a personal chat that
 * starts a child in a project, a chat in project A that starts one in project
 * B, and an agent on another machine that starts one here (or here, there).
 *
 * The chat service reports a finished child turn to its parent itself when the
 * parent is in the same service. When it is not, it hands the completion to
 * this router (`setExternalParentRouter`), which:
 *
 * 1. queues it in a durable outbox (survives a brain restart),
 * 2. delivers it — into another scope on this machine, or over the agents'
 *    machine bridge to the machine the parent runs on — with backoff from 30 s
 *    to 5 min, and
 * 3. gives up after 24 h, leaving a notice on the child.
 *
 * The receiving machine accepts a wake only for a child its own brain started
 * there (`recordRemoteChild`), so no other machine can inject turns into a
 * chat by naming it. A repeat is harmless: the parent transcript dedupes by
 * the child's turn id.
 */
import fs from "node:fs";
import path from "node:path";
import type { AdeRuntime } from "../../bootstrap";
import {
  externalChatContext,
  rememberExternalChat,
  type ExternalChatScope,
  type ExternalParentRouter,
  type ExternalParentWake,
} from "../../../../desktop/src/main/services/chat/externalChats";
import { parseForeignCallerSessionId } from "../../../../desktop/src/shared/runtimeClientNames";
import type { PermissionLevel } from "../../../../desktop/src/shared/permissionLadder";

type DeliveryResult = "delivered" | "parent_gone" | "failed";

/** What one machine sends another to wake a parent there. */
export type RemoteWakePayload = {
  /** The parent chat, as the receiving machine knows it (its own local id). */
  parentChatSessionId: string;
  wake: Omit<ExternalParentWake, "parentSessionId" | "childProjectRoot">;
};

type ProjectRecordLike = { projectId: string; rootPath: string };
type ScopeLike = { runtime: AdeRuntime };

export type CrossScopeChatsDeps = {
  projectRegistry: { list(): ProjectRecordLike[] };
  scopeRegistry: {
    get(projectId: string): Promise<ScopeLike>;
    getIfBooted(projectId: string): Promise<ScopeLike> | null;
  };
  personalChatScope: {
    runtimeForDelivery(): Promise<AdeRuntime>;
    peekRuntime(): Promise<AdeRuntime> | null;
  } | null;
  /** Deliver to another machine; absent on a brain with no machine bridge. */
  deliverRemote?: ((machineKey: string, payload: RemoteWakePayload) => Promise<DeliveryResult>) | null;
  stateDir: string;
  logger?: {
    info(event: string, meta?: Record<string, unknown>): void;
    warn(event: string, meta?: Record<string, unknown>): void;
  } | null;
  now?: () => number;
};

type OutboxEntry = {
  key: string;
  wake: ExternalParentWake;
  target: { kind: "local" } | { kind: "remote"; machineKey: string; parentChatSessionId: string };
  attempts: number;
  firstQueuedAt: number;
  nextAttemptAt: number;
};

type RemoteChildRecord = {
  parentChatSessionId: string;
  parentScope: ExternalChatScope | null;
  childSessionId: string;
  machineKey: string;
  machineName: string;
  createdAt: number;
};

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const PUMP_INTERVAL_MS = 30_000;
const MAX_OUTBOX = 1_000;
const MAX_REMOTE_CHILDREN = 2_000;
const REMOTE_CHILD_TTL_MS = 30 * 24 * 60 * 60_000;

function readJsonArray<T>(filePath: string): T[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return Array.isArray(raw) ? raw as T[] : [];
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type CrossScopeChats = ReturnType<typeof createCrossScopeChats>;

export function createCrossScopeChats(deps: CrossScopeChatsDeps) {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? null;
  const outboxPath = path.join(deps.stateDir, "external-parent-wakes.json");
  const childrenPath = path.join(deps.stateDir, "remote-children.json");
  let outbox: OutboxEntry[] = readJsonArray<OutboxEntry>(outboxPath);
  let remoteChildren: RemoteChildRecord[] = readJsonArray<RemoteChildRecord>(childrenPath)
    .filter((record) => now() - (record.createdAt ?? 0) < REMOTE_CHILD_TTL_MS);
  const saveOutbox = (): void => {
    try { writeJsonAtomic(outboxPath, outbox); } catch (error) {
      logger?.warn("cross_scope_chats.outbox_save_failed", { error: errorMessage(error) });
    }
  };
  const saveChildren = (): void => {
    try { writeJsonAtomic(childrenPath, remoteChildren); } catch (error) {
      logger?.warn("cross_scope_chats.children_save_failed", { error: errorMessage(error) });
    }
  };

  const hasChat = (runtime: AdeRuntime, sessionId: string): boolean =>
    runtime.agentChatService?.permissionLevelOf(sessionId) != null;

  /**
   * The runtime holding `sessionId` on this machine. `boot` decides whether an
   * unbooted project may be started to look; a scope hint goes straight there.
   */
  const locateChat = async (
    sessionId: string,
    options: { boot: boolean; hint?: ExternalChatScope | null },
  ): Promise<{ scope: ExternalChatScope; runtime: AdeRuntime } | null> => {
    const tryPersonal = async (boot: boolean) => {
      const pending = boot
        ? deps.personalChatScope?.runtimeForDelivery() ?? null
        : deps.personalChatScope?.peekRuntime() ?? null;
      const runtime = pending ? await pending.catch(() => null) : null;
      return runtime && hasChat(runtime, sessionId)
        ? { scope: { kind: "personal" } as const, runtime }
        : null;
    };
    const tryProject = async (projectId: string, boot: boolean) => {
      const pending = boot ? deps.scopeRegistry.get(projectId) : deps.scopeRegistry.getIfBooted(projectId);
      const scope = pending ? await pending.catch(() => null) : null;
      return scope && hasChat(scope.runtime, sessionId)
        ? { scope: { kind: "project", projectId } as const, runtime: scope.runtime }
        : null;
    };
    const hint = options.hint ?? null;
    if (hint?.kind === "personal") {
      const found = await tryPersonal(true);
      if (found) return found;
    } else if (hint?.kind === "project") {
      const found = await tryProject(hint.projectId, true);
      if (found) return found;
    }
    // Booted scopes first: cheap, and where a live parent almost always is.
    const personal = await tryPersonal(false);
    if (personal) return personal;
    for (const record of deps.projectRegistry.list()) {
      const found = await tryProject(record.projectId, false);
      if (found) return found;
    }
    if (!options.boot) return null;
    for (const record of deps.projectRegistry.list()) {
      if (deps.scopeRegistry.getIfBooted(record.projectId)) continue;
      const found = await tryProject(record.projectId, true);
      if (found) return found;
    }
    return null;
  };

  /**
   * Before a chat on this machine starts a child in a scope that is not its
   * own, record where it lives and how much it may do, so the child is clamped
   * to the right level and can find it again when it finishes.
   */
  const rememberLocalCaller = async (
    callerChatSessionId: string,
    target: ExternalChatScope,
  ): Promise<{ scope: ExternalChatScope; permissionLevel: PermissionLevel | null } | null> => {
    const located = await locateChat(callerChatSessionId, { boot: false });
    if (!located) return null;
    const sameScope = JSON.stringify(located.scope) === JSON.stringify(target);
    const permissionLevel = located.runtime.agentChatService?.permissionLevelOf(callerChatSessionId) ?? null;
    if (!sameScope) {
      rememberExternalChat(callerChatSessionId, {
        scope: located.scope,
        machineKey: null,
        machineName: null,
        permissionLevel,
      });
    }
    return { scope: located.scope, permissionLevel };
  };

  const recordRemoteChild = (record: Omit<RemoteChildRecord, "createdAt">): void => {
    remoteChildren = remoteChildren.filter((entry) => entry.childSessionId !== record.childSessionId);
    remoteChildren.push({ ...record, createdAt: now() });
    if (remoteChildren.length > MAX_REMOTE_CHILDREN) remoteChildren = remoteChildren.slice(-MAX_REMOTE_CHILDREN);
    saveChildren();
  };

  const deliverLocally = async (
    parentSessionId: string,
    wake: Omit<ExternalParentWake, "childProjectRoot" | "parentSessionId">,
    hint: ExternalChatScope | null,
  ): Promise<DeliveryResult> => {
    const located = await locateChat(parentSessionId, { boot: true, hint });
    if (!located?.runtime.agentChatService) return "parent_gone";
    return await located.runtime.agentChatService.deliverExternalChildCompletion({ ...wake, parentSessionId });
  };

  /**
   * A wake another machine sent for a parent here. Refused unless this brain
   * started that child on that machine for that parent.
   */
  const acceptRemoteWake = async (payload: RemoteWakePayload): Promise<DeliveryResult> => {
    const parentChatSessionId = payload.parentChatSessionId?.trim() ?? "";
    const childSessionId = payload.wake?.childSessionId?.trim() ?? "";
    const record = remoteChildren.find((entry) =>
      entry.childSessionId === childSessionId && entry.parentChatSessionId === parentChatSessionId);
    if (!record) {
      logger?.warn("cross_scope_chats.remote_wake_refused", { parentChatSessionId, childSessionId });
      throw new Error("No chat here started that child, so its report was not delivered.");
    }
    const readHint = `ade chat read ${childSessionId} --machine ${JSON.stringify(record.machineName)}`;
    return await deliverLocally(parentChatSessionId, {
      ...payload.wake,
      wakeText: `${payload.wake.wakeText}\n(It ran on ${record.machineName}. Read it with: ${readHint})`,
      spawnCompletion: { ...payload.wake.spawnCompletion, childMachineName: record.machineName },
    }, record.parentScope);
  };

  const noteOnChild = async (entry: OutboxEntry, reason: "parent_gone" | "gave_up"): Promise<void> => {
    try {
      const located = await locateChat(entry.wake.childSessionId, { boot: true });
      located?.runtime.agentChatService?.noteExternalParentUnreachable({
        childSessionId: entry.wake.childSessionId,
        parentSessionId: entry.wake.parentSessionId,
        childTurnId: entry.wake.spawnCompletion.childTurnId ?? null,
        reason,
      });
    } catch (error) {
      logger?.warn("cross_scope_chats.child_notice_failed", { childSessionId: entry.wake.childSessionId, error: errorMessage(error) });
    }
  };

  let pumping: Promise<void> | null = null;
  const pumpOnce = async (): Promise<void> => {
    const due = outbox.filter((entry) => entry.nextAttemptAt <= now());
    for (const entry of due) {
      let result: DeliveryResult;
      try {
        const { childProjectRoot: _root, parentSessionId: _parent, ...wake } = entry.wake;
        if (entry.target.kind === "remote") {
          const deliver = deps.deliverRemote;
          result = deliver
            ? await deliver(entry.target.machineKey, { parentChatSessionId: entry.target.parentChatSessionId, wake })
            : "failed";
        } else {
          result = await deliverLocally(
            entry.wake.parentSessionId,
            wake,
            externalChatContext(entry.wake.parentSessionId)?.scope ?? null,
          );
        }
      } catch (error) {
        logger?.warn("cross_scope_chats.delivery_error", { key: entry.key, error: errorMessage(error) });
        result = "failed";
      }
      if (result === "delivered") {
        outbox = outbox.filter((candidate) => candidate.key !== entry.key);
        logger?.info("cross_scope_chats.delivered", { key: entry.key, target: entry.target.kind, attempts: entry.attempts + 1 });
      } else if (result === "parent_gone" || now() - entry.firstQueuedAt >= GIVE_UP_AFTER_MS) {
        outbox = outbox.filter((candidate) => candidate.key !== entry.key);
        await noteOnChild(entry, result === "parent_gone" ? "parent_gone" : "gave_up");
        logger?.info("cross_scope_chats.dropped", { key: entry.key, reason: result });
      } else {
        entry.attempts += 1;
        entry.nextAttemptAt = now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, entry.attempts - 1));
      }
      saveOutbox();
    }
  };
  const pump = (): Promise<void> => {
    pumping ??= pumpOnce().finally(() => { pumping = null; });
    return pumping;
  };

  const router: ExternalParentRouter = {
    route(wake) {
      const key = `${wake.parentSessionId}:${wake.childSessionId}:${wake.spawnCompletion.childTurnId ?? ""}`;
      if (outbox.some((entry) => entry.key === key)) return true;
      const foreign = parseForeignCallerSessionId(wake.parentSessionId);
      let target: OutboxEntry["target"];
      if (foreign) {
        const machineKey = externalChatContext(wake.parentSessionId)?.machineKey ?? null;
        if (!machineKey || !foreign.chatSessionId || !deps.deliverRemote) return false;
        target = { kind: "remote", machineKey, parentChatSessionId: foreign.chatSessionId };
      } else {
        target = { kind: "local" };
      }
      outbox.push({ key, wake, target, attempts: 0, firstQueuedAt: now(), nextAttemptAt: now() });
      if (outbox.length > MAX_OUTBOX) outbox = outbox.slice(-MAX_OUTBOX);
      saveOutbox();
      void pump();
      return true;
    },
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    router,
    locateChat,
    rememberLocalCaller,
    recordRemoteChild,
    acceptRemoteWake,
    pump,
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void pump(); }, PUMP_INTERVAL_MS);
      timer.unref?.();
      if (outbox.length) void pump();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** For diagnostics: how many completions are waiting to be delivered. */
    pendingCount: (): number => outbox.length,
  };
}
