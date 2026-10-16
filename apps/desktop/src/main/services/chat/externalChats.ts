/**
 * Chats that live OUTSIDE the chat service asking about them: in another
 * project or the personal scope on this machine, or on another machine
 * (`remote:<device>:<chat>`, see `foreignCallerSessionId`).
 *
 * A chat service only knows its own project's sessions. Two things need more:
 *
 * - **Permission ceilings.** A child never runs above the chat that spawned it.
 *   When that chat is elsewhere, its level is recorded here by the brain at the
 *   moment it asks for the child, so the child is clamped to the real level
 *   instead of the "unknown parent" floor (`ask`), which would stall every
 *   autonomous child on approvals.
 * - **Wakes.** When a child's parent is elsewhere, the chat service hands the
 *   completion to the brain's router instead of noting "parent gone". The
 *   router owns the durable outbox and delivery (`crossScopeChats` in the CLI
 *   brain).
 *
 * Both are process-wide: one brain, many project chat services. A host with no
 * router installed (a desktop-local runtime, tests) keeps the old behavior.
 */
import fs from "node:fs";
import path from "node:path";
import { readPermissionLevel, type PermissionLevel } from "../../../shared/permissionLadder";
import { parseForeignCallerSessionId } from "../../../shared/runtimeClientNames";
import type { AgentChatSpawnCompletion } from "../../../shared/types/chat";
import { writeFileAtomic } from "../state/durableFile";

/** Where a chat on THIS machine lives, so a wake can find it without a scan. */
export type ExternalChatScope = { kind: "project"; projectId: string } | { kind: "personal" };

export function sameExternalChatScope(
  left: ExternalChatScope | null | undefined,
  right: ExternalChatScope | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  if (left.kind === "personal" || right.kind === "personal") return left.kind === right.kind;
  return left.projectId === right.projectId;
}

export function readExternalChatScope(value: unknown): ExternalChatScope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "personal") return { kind: "personal" };
  if (record.kind === "project" && typeof record.projectId === "string" && record.projectId.trim()) {
    return { kind: "project", projectId: record.projectId.trim() };
  }
  return null;
}

export type ExternalChatContext = {
  /** Where it lives on this machine; null for a chat on another machine. */
  scope?: ExternalChatScope | null;
  /** The account machine the chat runs on; null for a chat on this machine. */
  machineKey: string | null;
  /** Display name of that machine, for the parent's completion row. */
  machineName: string | null;
  /** Its permission level when it asked for the child; null when unknown. */
  permissionLevel: PermissionLevel | null;
  updatedAt: number;
};

/**
 * How many chats the registry remembers. Entries from other machines are
 * evicted first, so a busy peer can never push out the local parents this
 * machine's own children report to.
 */
const MAX_EXTERNAL_CHATS = 500;
const externalChats = new Map<string, ExternalChatContext>();
/**
 * A child started here for another machine's chat → the token its wakes carry,
 * and when it was last stored or read. A token is dropped only after a month
 * unused: every report the child makes reads it, and a queued report reads it
 * at least every few minutes until it gives up after a day, so a child that
 * may still report never loses it to a busy machine starting others.
 */
const CHILD_WAKE_TOKEN_UNUSED_MS = 30 * 24 * 60 * 60_000;
/** How stale a read's timestamp may get before the read is persisted. */
const CHILD_WAKE_TOKEN_TOUCH_MS = 60 * 60_000;
const childWakeTokens = new Map<string, { token: string; usedAt: number }>();
let storePath: string | null = null;
let loaded = false;

/** Persist the registry at `filePath` (the brain's machine state dir). */
export function configureExternalChatStore(filePath: string | null): void {
  storePath = filePath;
  loaded = false;
  externalChats.clear();
  childWakeTokens.clear();
}

function readContext(value: unknown): ExternalChatContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    scope: readExternalChatScope(record.scope),
    machineKey: typeof record.machineKey === "string" ? record.machineKey : null,
    machineName: typeof record.machineName === "string" ? record.machineName : null,
    permissionLevel: readPermissionLevel(record.permissionLevel),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!storePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const stored = raw as { chats?: unknown; childWakeTokens?: unknown };
    for (const [id, value] of Object.entries(stored.chats && typeof stored.chats === "object" ? stored.chats : {})) {
      const context = readContext(value);
      if (context) externalChats.set(id, context);
    }
    for (const [childId, token] of Object.entries(
      stored.childWakeTokens && typeof stored.childWakeTokens === "object" ? stored.childWakeTokens : {},
    )) {
      // Older stores kept the bare token; it counts as used now.
      const record = typeof token === "string" ? { token, usedAt: Date.now() } : token as { token?: unknown; usedAt?: unknown };
      if (typeof record?.token === "string" && record.token) {
        childWakeTokens.set(childId, {
          token: record.token,
          usedAt: typeof record.usedAt === "number" ? record.usedAt : Date.now(),
        });
      }
    }
  } catch {
    // Missing or unreadable: start empty. Losing it costs a ceiling (the child
    // falls back to `ask`) or a wake route, never a wrong grant.
  }
}

function save(): void {
  if (!storePath) return;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
    writeFileAtomic(storePath, JSON.stringify({
      chats: Object.fromEntries(externalChats),
      childWakeTokens: Object.fromEntries(childWakeTokens),
    }), { mode: 0o600 });
  } catch {
    // Best effort; the in-memory copy still serves this process.
  }
}

function evictOldest(): void {
  while (externalChats.size > MAX_EXTERNAL_CHATS) {
    const foreign = [...externalChats.keys()].find((id) => parseForeignCallerSessionId(id) !== null);
    externalChats.delete(foreign ?? (externalChats.keys().next().value as string));
  }
}

export function rememberExternalChat(
  sessionId: string,
  context: Omit<ExternalChatContext, "updatedAt">,
): void {
  const id = sessionId.trim();
  if (!id) return;
  load();
  const previous = externalChats.get(id);
  if (
    previous
    && sameExternalChatScope(previous.scope, context.scope)
    && previous.machineKey === context.machineKey
    && previous.machineName === context.machineName
    && previous.permissionLevel === context.permissionLevel
  ) {
    return;
  }
  externalChats.delete(id);
  externalChats.set(id, { ...context, updatedAt: Date.now() });
  evictOldest();
  save();
}

export function externalChatContext(sessionId: string): ExternalChatContext | null {
  load();
  return externalChats.get(sessionId.trim()) ?? null;
}

/**
 * The token another machine handed over when it started this child here. The
 * child's wakes carry it back, so only the machine that started the child can
 * have its report accepted, whoever else learns the ids.
 */
export function rememberChildWakeToken(childSessionId: string, token: string): void {
  const id = childSessionId.trim();
  if (!id || !token) return;
  load();
  const at = Date.now();
  childWakeTokens.set(id, { token, usedAt: at });
  for (const [childId, entry] of childWakeTokens) {
    if (at - entry.usedAt > CHILD_WAKE_TOKEN_UNUSED_MS) childWakeTokens.delete(childId);
  }
  save();
}

export function childWakeToken(childSessionId: string): string | null {
  load();
  const entry = childWakeTokens.get(childSessionId.trim());
  if (!entry) return null;
  const at = Date.now();
  if (at - entry.usedAt > CHILD_WAKE_TOKEN_TOUCH_MS) {
    entry.usedAt = at;
    save();
  }
  return entry.token;
}

/** What delivering one child completion to its parent came to. */
export type ExternalWakeDeliveryResult =
  | "delivered"
  /** The parent chat no longer exists. */
  | "parent_gone"
  /** The parent's machine will never take it: it did not start this child. */
  | "refused"
  /** Not yet: the child's start has not been recorded on both ends. Retry. */
  | "pending"
  /** Not now (offline, busy, transport); try again later. */
  | "failed";

/** One finished child turn whose parent lives outside the reporting service. */
export type ExternalParentWake = {
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
  childProvider: string;
  spawnKind: "subagent" | "peer";
  resultStatus: AgentChatSpawnCompletion["status"];
  summary: string;
  spawnCompletion: AgentChatSpawnCompletion;
  wakeText: string;
  /** The child's project root, so a failure notice can find it again. */
  childProjectRoot: string;
};

/** The key one child turn's delivery to one parent is deduped under. */
export function spawnDeliveryKey(parentSessionId: string, childSessionId: string, childTurnId: string | null | undefined): string {
  return `${parentSessionId}:${childSessionId}:${childTurnId ?? ""}`;
}

const SPAWN_COMPLETION_STATUSES = new Set(["completed", "failed", "stopped"]);

/**
 * A wake from untrusted JSON: another machine's request, or the outbox file.
 * Null unless every field the delivery reads is there and well-typed.
 */
export function readExternalParentWake(
  value: unknown,
): Omit<ExternalParentWake, "parentSessionId" | "childProjectRoot"> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const completion = record.spawnCompletion && typeof record.spawnCompletion === "object"
    ? record.spawnCompletion as Record<string, unknown>
    : null;
  const text = (key: string, max: number): string | null =>
    typeof record[key] === "string" ? (record[key] as string).slice(0, max) : null;
  const childSessionId = text("childSessionId", 200);
  const spawnKind = record.spawnKind === "subagent" || record.spawnKind === "peer" ? record.spawnKind : null;
  const status = typeof record.resultStatus === "string" && SPAWN_COMPLETION_STATUSES.has(record.resultStatus)
    ? record.resultStatus as AgentChatSpawnCompletion["status"]
    : null;
  if (!childSessionId || !spawnKind || !status || !completion) return null;
  if (completion.childSessionId !== childSessionId) return null;
  const childTitle = text("childTitle", 300) ?? "Subagent";
  const summary = text("summary", 4_000) ?? "";
  return {
    childSessionId,
    childTitle,
    childProvider: text("childProvider", 64) ?? "unknown",
    spawnKind,
    resultStatus: status,
    summary,
    wakeText: text("wakeText", 6_000) ?? `Your subagent "${childTitle}" finished a turn — ${summary}`,
    spawnCompletion: {
      childSessionId,
      childTitle,
      spawnKind,
      status,
      ...(typeof completion.childTurnId === "string" ? { childTurnId: completion.childTurnId.slice(0, 200) } : {}),
      ...(typeof completion.summary === "string" ? { summary: completion.summary.slice(0, 4_000) } : {}),
      ...(typeof completion.humanMessageCount === "number" ? { humanMessageCount: completion.humanMessageCount } : {}),
    },
  };
}

export type ExternalParentRouter = {
  /**
   * Take a completion whose parent is not in the reporting chat service.
   * True when the router owns it from here (queued durably); false when it
   * cannot (no such chat anywhere it can reach), and the caller notes the
   * parent as gone.
   */
  route(wake: ExternalParentWake): boolean;
};

let router: ExternalParentRouter | null = null;

export function setExternalParentRouter(next: ExternalParentRouter | null): () => void {
  const previous = router;
  router = next;
  return () => {
    if (router === next) router = previous;
  };
}

export function getExternalParentRouter(): ExternalParentRouter | null {
  return router;
}
