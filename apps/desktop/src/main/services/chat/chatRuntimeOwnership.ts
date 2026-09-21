import os from "node:os";
import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";

/**
 * Which brain instance owns a chat's provider runtime.
 *
 * Two ADE brains can legitimately run against ONE ADE home at the same time —
 * `ade serve --socket /tmp/... --no-sync` next to the desktop app is the normal
 * way to poke at a live install. They share `ade.db`, so the second brain sees
 * every chat row the first one is driving, including the `active` ones. Without
 * an owner stamp it reads "an active chat with no runtime attached to ME" as
 * "a chat orphaned by a crash", relaunches the provider process, and then
 * terminalizes the FIRST brain's in-flight turn as interrupted — which is
 * exactly what happened to chat 67757bac on 2026-09-18.
 *
 * `pid` alone is not identity (pids are reused, and a synced row can carry
 * another machine's pid), so ownership is the triple the runtime process
 * registry already heartbeats — `pid` + process `startedAt` — plus a
 * per-process `brainId` and the ADE home the brain was started against.
 */
/**
 * Per-brain-process identity, minted without the crypto RNG.
 *
 * `pid` + this process's wall-clock start instant is already unique on a
 * machine (a reused pid belongs to a later start), and the counter separates
 * two services constructed inside one process, which only happens in tests.
 */
let brainInstanceSeq = 0;
export function nextBrainInstanceId(now: () => number = Date.now, uptimeSeconds: () => number = () => process.uptime()): string {
  brainInstanceSeq += 1;
  const processStartedAtMs = Math.round(now() - uptimeSeconds() * 1_000);
  return `brain-${process.pid}-${processStartedAtMs}-${brainInstanceSeq}`;
}

export type ChatRuntimeOwner = {
  /** Stable for the lifetime of one brain process; survives pid reuse. */
  brainId: string;
  pid: number;
  /**
   * The owning process's incarnation stamp, as `runtime_processes.started_at`
   * records it. Null only for a stamp written before the registry was wired.
   */
  startedAt: string | null;
  /** ADE home the owner ran against — the shared-`ade.db` boundary. */
  adeHome: string | null;
  /** Control socket the owner listens on, when it has one. */
  socketPath?: string | null;
  claimedAt: string;
};

export type ChatRuntimeOwnershipVerdict =
  /** Nothing has ever claimed this chat's runtime (includes pre-upgrade rows). */
  | "legacy"
  /** This very brain process holds it. */
  | "self"
  /** Claimed against a different ADE home, so its pid says nothing here. */
  | "foreign-home"
  /** Claimed by a brain instance this machine can no longer find. */
  | "dead-owner"
  /** Claimed by a brain instance that is still heartbeating. Hands off. */
  | "live-foreign-brain";

export type ChatRuntimeOwnershipDecision = {
  /** May this brain adopt, relaunch, interrupt, or terminalize the session? */
  adoptable: boolean;
  verdict: ChatRuntimeOwnershipVerdict;
};

export type ChatRuntimeOwnerSelf = {
  brainId: string;
  pid: number;
  startedAt: string | null;
  adeHome: string | null;
  socketPath?: string | null;
};

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

/** The ADE home this process runs against — the same rule `crsqliteExtension` uses. */
export function resolveAdeHomeForOwnership(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = trimmedOrNull(env.ADE_HOME);
  return path.resolve(fromEnv ?? path.join(os.homedir(), ".ade"));
}

/**
 * Re-read a persisted owner stamp, dropping anything that cannot identify a
 * process. Unparseable ownership is treated as absent (→ `legacy` → adoptable)
 * rather than as a lock: a corrupt field must never strand a real chat.
 */
export function normalizeChatRuntimeOwner(value: unknown): ChatRuntimeOwner | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ChatRuntimeOwner>;
  const brainId = trimmedOrNull(record.brainId);
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : null;
  if (!brainId || pid == null) return null;
  return {
    brainId,
    pid,
    startedAt: trimmedOrNull(record.startedAt),
    adeHome: trimmedOrNull(record.adeHome),
    ...(trimmedOrNull(record.socketPath) ? { socketPath: trimmedOrNull(record.socketPath) } : {}),
    claimedAt: trimmedOrNull(record.claimedAt) ?? new Date().toISOString(),
  };
}

/**
 * The one ownership rule: a brain only owns and relaunches chats whose runtime
 * it owns.
 *
 * `isProcessIdentityLive` is deliberately injected rather than computed here —
 * it is the process registry's heartbeat-plus-liveness check, which is the only
 * pid probe in this codebase that is correct on Windows as well as POSIX. This
 * module never calls `process.kill` itself.
 */
export function decideChatRuntimeOwnership(args: {
  owner: ChatRuntimeOwner | null | undefined;
  self: ChatRuntimeOwnerSelf;
  isProcessIdentityLive: (pid: number, startedAt: string | null) => boolean;
  platform?: NodeJS.Platform;
}): ChatRuntimeOwnershipDecision {
  const owner = args.owner ?? null;
  // Missing ownership is a legacy record, not a claim. Every chat written
  // before this field existed has to stay recoverable.
  if (!owner) return { adoptable: true, verdict: "legacy" };
  if (owner.brainId === args.self.brainId) return { adoptable: true, verdict: "self" };
  // A stamp from another ADE home describes a process in another install's
  // registry; its pid is meaningless against ours, so it cannot hold a lock.
  if (owner.adeHome && args.self.adeHome && !pathsEqual(owner.adeHome, args.self.adeHome, args.platform)) {
    return { adoptable: true, verdict: "foreign-home" };
  }
  // Same home, different brain id: adoptable only once its process is gone.
  if (args.isProcessIdentityLive(owner.pid, owner.startedAt ?? null)) {
    return { adoptable: false, verdict: "live-foreign-brain" };
  }
  return { adoptable: true, verdict: "dead-owner" };
}
