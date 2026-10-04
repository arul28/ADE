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
 *   router owns the durable outbox and delivery (`externalParentWakes` in the
 *   CLI brain).
 *
 * Both are process-wide: one brain, many project chat services. A host with no
 * router installed (a desktop-local runtime, tests) keeps the old behavior.
 */
import fs from "node:fs";
import path from "node:path";
import type { PermissionLevel } from "../../../shared/permissionLadder";
import type { AgentChatSpawnCompletion } from "../../../shared/types/chat";

/** Where a chat on THIS machine lives, so a wake can find it without a scan. */
export type ExternalChatScope = { kind: "project"; projectId: string } | { kind: "personal" };

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

const MAX_EXTERNAL_CHATS = 500;
const externalChats = new Map<string, ExternalChatContext>();
let storePath: string | null = null;
let loaded = false;

/** Persist the registry at `filePath` (the brain's machine state dir). */
export function configureExternalChatStore(filePath: string | null): void {
  storePath = filePath;
  loaded = false;
}

function load(): void {
  if (loaded) return;
  loaded = true;
  if (!storePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      const scope = record.scope && typeof record.scope === "object" ? record.scope as Record<string, unknown> : null;
      externalChats.set(id, {
        scope: scope?.kind === "personal"
          ? { kind: "personal" }
          : scope?.kind === "project" && typeof scope.projectId === "string"
            ? { kind: "project", projectId: scope.projectId }
            : null,
        machineKey: typeof record.machineKey === "string" ? record.machineKey : null,
        machineName: typeof record.machineName === "string" ? record.machineName : null,
        permissionLevel: typeof record.permissionLevel === "string"
          ? record.permissionLevel as PermissionLevel
          : null,
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
      });
    }
  } catch {
    // Missing or unreadable: start empty. Losing it costs a ceiling (the child
    // falls back to `ask`) or a wake route, never a wrong grant.
  }
}

function save(): void {
  if (!storePath) return;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(externalChats)), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
  } catch {
    // Best effort; the in-memory copy still serves this process.
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
    && JSON.stringify(previous.scope ?? null) === JSON.stringify(context.scope ?? null)
    && previous.machineKey === context.machineKey
    && previous.machineName === context.machineName
    && previous.permissionLevel === context.permissionLevel
  ) {
    return;
  }
  externalChats.delete(id);
  externalChats.set(id, { ...context, updatedAt: Date.now() });
  while (externalChats.size > MAX_EXTERNAL_CHATS) {
    const oldest = externalChats.keys().next().value as string;
    externalChats.delete(oldest);
  }
  save();
}

export function externalChatContext(sessionId: string): ExternalChatContext | null {
  load();
  return externalChats.get(sessionId.trim()) ?? null;
}

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
