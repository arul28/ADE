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
 * Only parents the brain recorded are routed (`rememberExternalChat`): a chat
 * in another scope that asked for this child, or a caller on another machine.
 * Any other missing parent is simply gone, as it was before, and booting every
 * project to look for it is never worth it.
 *
 * The receiving machine accepts a wake only for a child its own brain started
 * there, carrying the token it handed over then (`recordRemoteChild`), so no
 * other machine can inject turns into a chat by naming it. A repeat is
 * harmless: the parent transcript dedupes by the child's turn id.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AdeRuntime } from "../../bootstrap";
import {
  childWakeToken,
  externalChatContext,
  readExternalChatScope,
  readExternalParentWake,
  rememberExternalChat,
  sameExternalChatScope,
  spawnDeliveryKey,
  type ExternalChatScope,
  type ExternalParentRouter,
  type ExternalParentWake,
  type ExternalParentWakePayload,
  type ExternalWakeDeliveryResult,
} from "../../../../desktop/src/main/services/chat/externalChats";
import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import { resolveReadableHistoryPath } from "../../../../desktop/src/main/services/storage/historyCompression";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { samePathOnPlatform } from "../../../../desktop/src/shared/pathContainment";
import { parseForeignCallerSessionId } from "../../../../desktop/src/shared/runtimeClientNames";
import type { PermissionLevel } from "../../../../desktop/src/shared/permissionLadder";
import { errorMessage, isRecord } from "../account/machineBridge";

/** What one machine sends another to wake a parent there. */
export type RemoteWakePayload = {
  /** The parent chat, as the receiving machine knows it (its own local id). */
  parentChatSessionId: string;
  /** The token the receiving machine handed over when it started the child. */
  wakeToken: string;
  wake: ExternalParentWakePayload;
};

type ProjectRecordLike = { projectId: string; rootPath: string };
type ScopeLike = { runtime: AdeRuntime };

export type CrossScopeChatsDeps = {
  projectRegistry: { list(): ProjectRecordLike[] };
  scopeRegistry: {
    get(projectId: string): Promise<ScopeLike>;
    getIfBooted(projectId: string): Promise<ScopeLike> | null;
    /** A project refused as too slow to open: its folder is not read here. */
    isOpenBlocked(projectId: string): boolean;
  };
  personalChatScope: {
    runtimeForDelivery(): Promise<AdeRuntime>;
    peekRuntime(): Promise<AdeRuntime> | null;
  } | null;
  /** Deliver to another machine; absent on a brain with no machine bridge. */
  deliverRemote?: ((machineKey: string, payload: RemoteWakePayload) => Promise<ExternalWakeDeliveryResult>) | null;
  stateDir: string;
  /**
   * This brain's own endpoint. Brains that share one home each keep their own
   * outbox file under it, so none overwrites or delivers another's reports.
   */
  ownerId?: string | null;
  /**
   * This is the machine's own brain: it takes over the shared outbox file
   * that builds before per-brain files wrote. Other brains leave it alone.
   */
  adoptLegacyOutbox?: boolean;
  logger?: {
    info(event: string, meta?: Record<string, unknown>): void;
    warn(event: string, meta?: Record<string, unknown>): void;
  } | null;
  now?: () => number;
};

type OutboxTarget =
  /**
   * A parent on this machine. With `scope`, the parent is a chat in the
   * child's own scope, queued so its report survives a restart; that scope is
   * opened to deliver it, and a chat missing from it is gone.
   */
  | { kind: "local"; scope?: ExternalChatScope }
  | { kind: "remote"; machineKey: string; parentChatSessionId: string };

type OutboxEntry = {
  key: string;
  wake: ExternalParentWake;
  target: OutboxTarget;
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
  wakeToken: string;
  /** When it was recorded, or last reported here. */
  usedAt: number;
};

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 5 * 60_000;
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
const PUMP_INTERVAL_MS = 30_000;
const MAX_OUTBOX = 1_000;
const OUTBOX_PREFIX = "external-parent-wakes";
/**
 * A child started on another machine is forgotten after a month without a
 * report, the same rule that machine keeps for its token: never by count, so
 * a busy parent machine cannot push out a child that is still working.
 */
const REMOTE_CHILD_UNUSED_MS = 30 * 24 * 60 * 60_000;
/** How stale a report's timestamp may get before it is persisted. */
const REMOTE_CHILD_TOUCH_MS = 60 * 60_000;

function readJsonArray(filePath: string): unknown[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readOutboxEntry(value: unknown): OutboxEntry | null {
  const record = asRecord(value);
  const wakeRecord = asRecord(record?.wake);
  const target = asRecord(record?.target);
  if (!record || !wakeRecord || !target || typeof record.key !== "string") return null;
  const wake = readExternalParentWake(wakeRecord);
  const parentSessionId = typeof wakeRecord.parentSessionId === "string" ? wakeRecord.parentSessionId : "";
  const childProjectRoot = typeof wakeRecord.childProjectRoot === "string" ? wakeRecord.childProjectRoot : "";
  if (!wake || !parentSessionId) return null;
  let outboxTarget: OutboxTarget;
  if (target.kind === "local") {
    const scope = readExternalChatScope(target.scope);
    outboxTarget = scope ? { kind: "local", scope } : { kind: "local" };
  } else if (target.kind === "remote" && typeof target.machineKey === "string" && typeof target.parentChatSessionId === "string") {
    outboxTarget = { kind: "remote", machineKey: target.machineKey, parentChatSessionId: target.parentChatSessionId };
  } else {
    return null;
  }
  const number = (key: string): number => (typeof record[key] === "number" ? record[key] as number : 0);
  return {
    key: record.key,
    wake: { ...wake, parentSessionId, childProjectRoot },
    target: outboxTarget,
    attempts: number("attempts"),
    firstQueuedAt: number("firstQueuedAt"),
    nextAttemptAt: number("nextAttemptAt"),
  };
}

function readRemoteChild(value: unknown): RemoteChildRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const text = (key: string): string | null => (typeof record[key] === "string" && record[key] ? record[key] as string : null);
  const parentChatSessionId = text("parentChatSessionId");
  const childSessionId = text("childSessionId");
  const machineKey = text("machineKey");
  const wakeToken = text("wakeToken");
  if (!parentChatSessionId || !childSessionId || !machineKey || !wakeToken) return null;
  return {
    parentChatSessionId,
    parentScope: readExternalChatScope(record.parentScope),
    childSessionId,
    machineKey,
    machineName: text("machineName") ?? machineKey,
    wakeToken,
    // Older stores named it `createdAt`.
    usedAt: typeof record.usedAt === "number" ? record.usedAt : typeof record.createdAt === "number" ? record.createdAt : 0,
  };
}

function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type CrossScopeChats = ReturnType<typeof createCrossScopeChats>;

export function createCrossScopeChats(deps: CrossScopeChatsDeps) {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? null;
  // Brains that share one home each keep their own outbox file, named by
  // their endpoint: one writer per file, so no brain overwrites or takes
  // another's reports. Without an endpoint (embedded, tests) the shared name.
  const ownerId = deps.ownerId?.trim() || null;
  const outboxPath = path.join(
    deps.stateDir,
    ownerId ? `${OUTBOX_PREFIX}-${createHash("sha256").update(ownerId).digest("hex").slice(0, 16)}.json` : `${OUTBOX_PREFIX}.json`,
  );
  const childrenPath = path.join(deps.stateDir, "remote-children.json");
  const readOutboxFile = (filePath: string): OutboxEntry[] =>
    readJsonArray(filePath).flatMap((entry) => readOutboxEntry(entry) ?? []);
  let outbox: OutboxEntry[] = readOutboxFile(outboxPath);
  /**
   * Take over reports nobody else will deliver: the shared file older builds
   * wrote (only the machine's own brain, the one those builds were), and the
   * file of a brain that has not written for the give-up age (it never came
   * back: a dev brain on its own socket, a renamed endpoint). Taken entries
   * are tried once more and then given up with the usual note. Returns the
   * files taken from; they are deleted only once this brain's file holds
   * their entries, so a restart in between loses nothing.
   */
  const adoptOrphanedOutboxes = (): string[] => {
    if (!ownerId) return [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(deps.stateDir);
    } catch {
      return [];
    }
    const sources: string[] = [];
    const known = new Set(outbox.map((entry) => entry.key));
    for (const name of names) {
      if (!name.startsWith(OUTBOX_PREFIX) || !name.endsWith(".json")) continue;
      const filePath = path.join(deps.stateDir, name);
      if (filePath === outboxPath) continue;
      const legacy = name === `${OUTBOX_PREFIX}.json`;
      try {
        if (legacy ? !deps.adoptLegacyOutbox : now() - fs.statSync(filePath).mtimeMs < GIVE_UP_AFTER_MS) continue;
        const taken = readOutboxFile(filePath).filter((entry) => !known.has(entry.key));
        for (const entry of taken) known.add(entry.key);
        outbox.push(...taken);
        sources.push(filePath);
        if (taken.length) logger?.info("cross_scope_chats.outbox_adopted", { file: name, entries: taken.length });
      } catch (error) {
        logger?.warn("cross_scope_chats.outbox_adopt_failed", { file: name, error: errorMessage(error) });
      }
    }
    return sources;
  };
  const adoptedSources = adoptOrphanedOutboxes();
  let remoteChildren: RemoteChildRecord[] = readJsonArray(childrenPath)
    .flatMap((entry) => readRemoteChild(entry) ?? [])
    .filter((record) => now() - record.usedAt < REMOTE_CHILD_UNUSED_MS);
  /** False when the write failed (logged): the caller must not count on it being on disk. */
  const persist = (filePath: string, value: unknown, label: string): boolean => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(filePath, JSON.stringify(value), { mode: 0o600 });
      return true;
    } catch (error) {
      logger?.warn(`cross_scope_chats.${label}_save_failed`, { error: errorMessage(error) });
      return false;
    }
  };
  /** An empty outbox leaves no file, so a brain gone quiet is never mistaken for one with reports. */
  const saveOutbox = (): boolean => {
    if (outbox.length === 0 && ownerId) {
      try {
        fs.rmSync(outboxPath, { force: true });
        return true;
      } catch (error) {
        logger?.warn("cross_scope_chats.outbox_save_failed", { error: errorMessage(error) });
        return false;
      }
    }
    return persist(outboxPath, outbox, "outbox");
  };
  if (adoptedSources.length && saveOutbox()) {
    for (const filePath of adoptedSources) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch (error) {
        // Left behind: its entries are already in this brain's file, and a
        // repeat is deduped by key.
        logger?.warn("cross_scope_chats.outbox_adopt_cleanup_failed", { error: errorMessage(error) });
      }
    }
  }
  const forgetEntry = (key: string): void => {
    outbox = outbox.filter((candidate) => candidate.key !== key);
  };
  const trimOutbox = (): void => {
    if (outbox.length > MAX_OUTBOX) outbox = outbox.slice(-MAX_OUTBOX);
  };
  const saveChildren = (): void => {
    persist(childrenPath, remoteChildren, "children");
  };

  const hasChat = (runtime: AdeRuntime, sessionId: string): boolean =>
    runtime.agentChatService?.permissionLevelOf(sessionId) != null;

  /**
   * The runtime holding `sessionId` on this machine. Booted scopes are always
   * searched; with `boot`, the hinted scope may be started to look. Nothing
   * else is ever booted: a full project boot opens its database and builds
   * every service.
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
      const found = await tryPersonal(options.boot);
      if (found) return found;
    } else if (hint?.kind === "project") {
      const found = await tryProject(hint.projectId, options.boot);
      if (found) return found;
    }
    const personal = await tryPersonal(false);
    if (personal) return personal;
    for (const record of deps.projectRegistry.list()) {
      const found = await tryProject(record.projectId, false);
      if (found) return found;
    }
    return null;
  };

  /**
   * Where a chat id lives on this machine, for another machine (or this CLI)
   * asking "do you have it?". Booted scopes first, then each project's
   * transcripts on disk, so an unopened project still answers. Never boots.
   */
  const findChat = async (sessionId: string): Promise<ExternalChatScope | null> => {
    const located = await locateChat(sessionId, { boot: false });
    if (located) return located.scope;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
    for (const record of deps.projectRegistry.list()) {
      // A refused project's transcripts are not stat'd here, on the brain's thread.
      if (deps.scopeRegistry.isOpenBlocked(record.projectId)) continue;
      const layout = resolveAdeLayout(record.rootPath);
      const onDisk = resolveReadableHistoryPath(path.join(layout.chatTranscriptsDir, `${sessionId}.jsonl`))
        ?? resolveReadableHistoryPath(path.join(layout.transcriptsDir, `${sessionId}.chat.jsonl`));
      if (onDisk) return { kind: "project", projectId: record.projectId };
    }
    return null;
  };

  /** The scope a child's own project root names, for its failure notice. */
  const scopeOfProjectRoot = (rootPath: string): ExternalChatScope => {
    const record = deps.projectRegistry.list().find((candidate) => samePathOnPlatform(candidate.rootPath, rootPath));
    return record ? { kind: "project", projectId: record.projectId } : { kind: "personal" };
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
    const permissionLevel = located.runtime.agentChatService?.permissionLevelOf(callerChatSessionId) ?? null;
    if (!sameExternalChatScope(located.scope, target)) {
      rememberExternalChat(callerChatSessionId, {
        scope: located.scope,
        machineKey: null,
        machineName: null,
        permissionLevel,
      });
    }
    return { scope: located.scope, permissionLevel };
  };

  const recordRemoteChild = (record: Omit<RemoteChildRecord, "usedAt">): void => {
    const at = now();
    remoteChildren = remoteChildren.filter((entry) =>
      entry.childSessionId !== record.childSessionId && at - entry.usedAt < REMOTE_CHILD_UNUSED_MS);
    remoteChildren.push({ ...record, usedAt: at });
    saveChildren();
  };

  const deliverLocally = async (
    parentSessionId: string,
    wake: ExternalParentWakePayload,
    hint: ExternalChatScope | null,
  ): Promise<ExternalWakeDeliveryResult> => {
    const located = await locateChat(parentSessionId, { boot: true, hint });
    if (!located?.runtime.agentChatService) return "parent_gone";
    return await located.runtime.agentChatService.deliverExternalChildCompletion({ ...wake, parentSessionId });
  };

  /**
   * A wake another machine sent for a parent here. Refused unless this brain
   * started that child on that machine for that parent, and the wake carries
   * the token handed over then.
   */
  const acceptRemoteWake = async (payload: unknown): Promise<ExternalWakeDeliveryResult> => {
    const record = asRecord(payload);
    const wake = readExternalParentWake(record?.wake);
    const parentChatSessionId = typeof record?.parentChatSessionId === "string" ? record.parentChatSessionId : "";
    const wakeToken = typeof record?.wakeToken === "string" ? record.wakeToken : "";
    const known = wake ? remoteChildren.filter((entry) => entry.childSessionId === wake.childSessionId) : [];
    const child = known.find((entry) => entry.parentChatSessionId === parentChatSessionId);
    // A child this brain does not know YET is not refused: its create may
    // still be on its way back here while its first, fast turn already
    // reported. The sender retries; a wake for a child that never appears
    // runs out with the sender's 24 h limit. A known child named with
    // another parent is refused.
    if (wake && known.length === 0) return "pending";
    if (!wake || !child || !wakeToken || !tokensMatch(child.wakeToken, wakeToken)) {
      logger?.warn("cross_scope_chats.remote_wake_refused", {
        parentChatSessionId,
        childSessionId: wake?.childSessionId ?? null,
      });
      return "refused";
    }
    if (now() - child.usedAt > REMOTE_CHILD_TOUCH_MS) {
      child.usedAt = now();
      saveChildren();
    }
    const readHint = `ade chat read ${child.childSessionId} --machine ${JSON.stringify(child.machineName)}`;
    return await deliverLocally(parentChatSessionId, {
      ...wake,
      wakeText: `${wake.wakeText}\n(It ran on ${child.machineName}. Read it with: ${readHint})`,
      spawnCompletion: { ...wake.spawnCompletion, childMachineName: child.machineName },
    }, child.parentScope);
  };

  /** Deliver into a parent in one known scope, opening it when needed. */
  const deliverInScope = async (
    scope: ExternalChatScope,
    parentSessionId: string,
    wake: ExternalParentWakePayload,
  ): Promise<ExternalWakeDeliveryResult> => {
    let runtime: AdeRuntime | null = null;
    try {
      runtime = scope.kind === "personal"
        ? await deps.personalChatScope?.runtimeForDelivery() ?? null
        : (await deps.scopeRegistry.get(scope.projectId)).runtime;
    } catch (error) {
      // The scope did not open (shutting down, refused as too slow): that says
      // nothing about the parent, so try again later.
      logger?.warn("cross_scope_chats.scope_open_failed", { scope, error: errorMessage(error) });
      return "failed";
    }
    if (!runtime?.agentChatService) return "failed";
    if (hasChat(runtime, parentSessionId)) {
      return await runtime.agentChatService.deliverExternalChildCompletion({ ...wake, parentSessionId });
    }
    // Not in the pinned scope. The pin came from a path match against the
    // project registry, which can miss (a project re-registered under another
    // path); look in every open scope before calling the parent gone, or a
    // live parent would lose its child to an ancestor.
    const located = await locateChat(parentSessionId, { boot: false, hint: scope });
    if (!located?.runtime.agentChatService) return "parent_gone";
    return await located.runtime.agentChatService.deliverExternalChildCompletion({ ...wake, parentSessionId });
  };

  const noteOnChild = async (entry: OutboxEntry, reason: "parent_gone" | "gave_up" | "refused"): Promise<void> => {
    try {
      const located = await locateChat(entry.wake.childSessionId, {
        boot: true,
        hint: scopeOfProjectRoot(entry.wake.childProjectRoot),
      });
      located?.runtime.agentChatService?.noteExternalParentUnreachable({
        childSessionId: entry.wake.childSessionId,
        parentSessionId: entry.wake.parentSessionId,
        parentMachineName: externalChatContext(entry.wake.parentSessionId)?.machineName ?? null,
        childTurnId: entry.wake.spawnCompletion.childTurnId ?? null,
        reason,
        // A same-scope parent that is gone: the child may report to the
        // nearest live chat above it instead, with this same report.
        ...(entry.target.kind === "local" && entry.target.scope ? { wake: entry.wake } : {}),
      });
    } catch (error) {
      logger?.warn("cross_scope_chats.child_notice_failed", { childSessionId: entry.wake.childSessionId, error: errorMessage(error) });
    }
  };

  const deliver = async (entry: OutboxEntry): Promise<ExternalWakeDeliveryResult> => {
    const { childProjectRoot: _root, parentSessionId: _parent, ...wake } = entry.wake;
    if (entry.target.kind === "local" && entry.target.scope) {
      return await deliverInScope(entry.target.scope, entry.wake.parentSessionId, wake);
    }
    if (entry.target.kind === "local") {
      return await deliverLocally(
        entry.wake.parentSessionId,
        wake,
        externalChatContext(entry.wake.parentSessionId)?.scope ?? null,
      );
    }
    // No bridge on this brain: it can never reach another machine.
    if (!deps.deliverRemote) return "failed";
    // No token yet: the create that brings it may not have returned here, while
    // the child's first turn already ended. Try again later.
    const token = childWakeToken(entry.wake.childSessionId);
    if (!token) return "pending";
    return await deps.deliverRemote(entry.target.machineKey, {
      parentChatSessionId: entry.target.parentChatSessionId,
      wakeToken: token,
      wake,
    });
  };

  /** Entries a delivery is running for right now: never tried twice at once. */
  const inFlight = new Set<string>();

  const settle = async (entry: OutboxEntry, result: ExternalWakeDeliveryResult): Promise<void> => {
    if (result === "delivered") {
      forgetEntry(entry.key);
      logger?.info("cross_scope_chats.delivered", { key: entry.key, target: entry.target.kind, attempts: entry.attempts + 1 });
    } else if ((result === "failed" || result === "pending") && now() - entry.firstQueuedAt < GIVE_UP_AFTER_MS) {
      entry.attempts += 1;
      entry.nextAttemptAt = now() + Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.max(0, entry.attempts - 1));
    } else {
      forgetEntry(entry.key);
      await noteOnChild(entry, result === "parent_gone" || result === "refused" ? result : "gave_up");
      logger?.info("cross_scope_chats.dropped", { key: entry.key, reason: result });
    }
    saveOutbox();
  };

  const attempt = async (entry: OutboxEntry): Promise<ExternalWakeDeliveryResult> => {
    inFlight.add(entry.key);
    try {
      let result: ExternalWakeDeliveryResult;
      try {
        result = await deliver(entry);
      } catch (error) {
        logger?.warn("cross_scope_chats.delivery_error", { key: entry.key, error: errorMessage(error) });
        result = "failed";
      }
      await settle(entry, result);
      return result;
    } finally {
      inFlight.delete(entry.key);
    }
  };

  let pumping: Promise<void> | null = null;
  const pumpOnce = async (): Promise<void> => {
    const due = outbox.filter((entry) => entry.nextAttemptAt <= now());
    // One dark machine must not hold up everything queued behind it: after its
    // first failure in a pass, its other entries wait for the next one.
    const unreachable = new Set<string>();
    for (const entry of due) {
      // Being tried right now (a fresh local report), or settled meanwhile.
      if (inFlight.has(entry.key) || !outbox.includes(entry)) continue;
      const targetKey = entry.target.kind === "remote" ? entry.target.machineKey : "local";
      if (unreachable.has(targetKey)) {
        await settle(entry, "failed");
        continue;
      }
      const result = await attempt(entry);
      // Only a transport failure says the machine is dark; "pending" is one
      // child waiting on its own handshake.
      if (result === "failed" && entry.target.kind === "remote") unreachable.add(targetKey);
    }
  };
  const pump = (): Promise<void> => {
    pumping ??= pumpOnce().finally(() => { pumping = null; });
    return pumping;
  };

  const router: ExternalParentRouter = {
    route(wake) {
      const key = spawnDeliveryKey(wake.parentSessionId, wake.childSessionId, wake.spawnCompletion.childTurnId);
      if (outbox.some((entry) => entry.key === key)) return true;
      const context = externalChatContext(wake.parentSessionId);
      // Only a parent the brain recorded is routed. Any other parent missing
      // from the reporting service was deleted, or never was a chat.
      if (!context) return false;
      const foreign = parseForeignCallerSessionId(wake.parentSessionId);
      let target: OutboxTarget;
      if (foreign) {
        if (!context.machineKey || !foreign.chatSessionId || !deps.deliverRemote) return false;
        target = { kind: "remote", machineKey: context.machineKey, parentChatSessionId: foreign.chatSessionId };
      } else {
        target = { kind: "local" };
      }
      outbox.push({ key, wake, target, attempts: 0, firstQueuedAt: now(), nextAttemptAt: now() });
      trimOutbox();
      saveOutbox();
      void pump();
      return true;
    },
    queueLocal(wake) {
      const key = spawnDeliveryKey(wake.parentSessionId, wake.childSessionId, wake.spawnCompletion.childTurnId);
      if (outbox.some((entry) => entry.key === key)) return true;
      const entry: OutboxEntry = {
        key,
        wake,
        target: {
          kind: "local",
          scope: scopeOfProjectRoot(wake.childProjectRoot),
        },
        attempts: 0,
        firstQueuedAt: now(),
        nextAttemptAt: now(),
      };
      outbox.push(entry);
      trimOutbox();
      if (!saveOutbox()) {
        // Not on disk, so not durable: hand it back and let the caller
        // deliver it directly, as it does with no router.
        forgetEntry(key);
        return false;
      }
      // Saved first, then tried at once on its own: a report to a chat here
      // must not wait in the pump behind another machine's slow delivery.
      void attempt(entry);
      return true;
    },
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    router,
    locateChat,
    findChat,
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
  };
}
