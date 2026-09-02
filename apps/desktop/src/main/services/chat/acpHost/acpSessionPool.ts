/**
 * Connection pool for ACP agent processes.
 *
 * The pool key is `{providerId, cwd, envHash}`. Two chats in the same lane with
 * the same environment share one agent process, because a session is a
 * protocol object inside that process and `session/new` is cheap.
 *
 * Three rules come from `droidSdkPool.ts` and `piSdkPool.ts` and are kept:
 *
 * - A generation counter guards release. A caller that releases a stale
 *   generation must not tear down the connection that replaced it.
 * - A dead process is never handed out. The entry is dropped and rebuilt.
 * - Concurrent acquisitions of the same key share one in-flight build.
 *
 * Two rules are new here:
 *
 * - **Idle time to live.** The last release starts a timer instead of an
 *   immediate kill. A user who closes a chat and opens another in the same lane
 *   reuses the warm process. A re-acquisition inside the window cancels the
 *   timer.
 * - **One process per session.** A dialect whose close style is `kill_process`
 *   has no `session/close`, so ending a chat means ending a process. Sharing
 *   would make one chat's close kill another chat's session. Such a dialect
 *   gets a private key per session and no idle window.
 */

import { createHash } from "node:crypto";
import type { Logger } from "../../logging/logger";
import {
  createAcpConnection,
  initializeAcpConnection,
  type AcpConnection,
} from "./acpConnection";
import type { AcpDialect, AcpSpawnPlan } from "./acpHostTypes";

/** How long an unused connection stays warm before the pool ends it. */
export const ACP_IDLE_TTL_MS = 60_000;

export type AcpPoolKeyParts = {
  providerId: string;
  cwd: string;
  envHash: string;
  /**
   * Hash of the command and its arguments.
   *
   * This is not decoration. Several providers take the model and the reasoning
   * effort as process-global spawn flags: Grok uses `-m` and
   * `--reasoning-effort`, and Copilot uses `--effort`, which `session/new`
   * cannot override. Without the argument hash, two chats on different models
   * would share one process and the second chat would silently run on the
   * first chat's model.
   */
  invocationHash: string;
  /** Set for a `kill_process` dialect. Makes the key private to one session. */
  privateToken?: string | null;
};

/**
 * Hash the environment entries that change agent behavior.
 *
 * Hashing the whole environment would make every process share nothing,
 * because ADE sets per-chat variables that do not change how the agent runs.
 * The caller passes only the keys that matter for the dialect.
 */
export function hashPoolEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string {
  const hash = createHash("sha256");
  for (const key of [...keys].sort()) {
    hash.update(key);
    hash.update("\u0000");
    hash.update(env[key] ?? "");
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Hash the executable and its arguments. See `invocationHash`. */
export function hashSpawnInvocation(plan: Pick<AcpSpawnPlan, "command" | "args">): string {
  const hash = createHash("sha256");
  hash.update(plan.command);
  for (const arg of plan.args) {
    hash.update("\u0000");
    hash.update(arg);
  }
  return hash.digest("hex").slice(0, 16);
}

export function buildAcpPoolKey(parts: AcpPoolKeyParts): string {
  const base = `${parts.providerId}:${parts.cwd}:${parts.envHash}:${parts.invocationHash}`;
  return parts.privateToken ? `${base}:${parts.privateToken}` : base;
}

export type AcpPooledConnection = {
  connection: AcpConnection;
  generation: number;
  poolKey: string;
  /** Release this lease. Idempotent. */
  release: () => void;
  /** End the process now, whatever the reference count says. */
  evict: (reason: string) => void;
};

type PoolEntry = {
  connection: AcpConnection;
  generation: number;
  refCount: number;
  idleTimer: NodeJS.Timeout | null;
  idleTtlMs: number;
};

export type AcpSessionPool = {
  acquire(args: AcquireAcpConnectionArgs): Promise<AcpPooledConnection>;
  /** Number of live entries. Diagnostics and tests. */
  size(): number;
  /** True when the key currently holds a live connection. */
  has(poolKey: string): boolean;
  /** End every connection. Call on shutdown. */
  disposeAll(reason: string): void;
};

export type AcquireAcpConnectionArgs = {
  dialect: AcpDialect;
  spawnPlan: AcpSpawnPlan;
  /**
   * Environment keys that must match for two chats to share a process. The
   * dialect's config home and any model or effort flag belong here.
   */
  poolEnvKeys: readonly string[];
  /**
   * Unique per ADE chat session. Used only when the dialect demands one process
   * per session.
   */
  sessionToken: string;
  logger?: Logger;
  idleTtlMs?: number;
  handshakeTimeoutMs?: number;
  /** Test seam, forwarded to `createAcpConnection`. */
  spawnOverride?: Parameters<typeof createAcpConnection>[0]["spawnOverride"];
};

export function createAcpSessionPool(): AcpSessionPool {
  const entries = new Map<string, PoolEntry>();
  const building = new Map<string, Promise<PoolEntry>>();
  let generationCounter = 0;

  const dropEntry = (poolKey: string, entry: PoolEntry, reason: string) => {
    if (entries.get(poolKey) !== entry) return;
    entries.delete(poolKey);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.connection.dispose(reason);
  };

  const startIdleTimer = (poolKey: string, entry: PoolEntry) => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.idleTtlMs <= 0) {
      dropEntry(poolKey, entry, "idle, no warm window for this dialect");
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.refCount > 0) return;
      dropEntry(poolKey, entry, "idle time to live elapsed");
    }, entry.idleTtlMs);
    entry.idleTimer.unref?.();
  };

  const lease = (poolKey: string, entry: PoolEntry): AcpPooledConnection => {
    entry.refCount += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const generation = entry.generation;
    let released = false;
    return {
      connection: entry.connection,
      generation,
      poolKey,
      release: () => {
        if (released) return;
        released = true;
        const current = entries.get(poolKey);
        // A stale release must not touch the connection that replaced this one.
        if (!current || current.generation !== generation) return;
        current.refCount = Math.max(0, current.refCount - 1);
        if (current.refCount === 0) startIdleTimer(poolKey, current);
      },
      evict: (reason: string) => {
        released = true;
        const current = entries.get(poolKey);
        if (!current || current.generation !== generation) return;
        dropEntry(poolKey, current, reason);
      },
    };
  };

  const build = async (poolKey: string, args: AcquireAcpConnectionArgs): Promise<PoolEntry> => {
    const connection = createAcpConnection({
      dialect: args.dialect,
      spawnPlan: args.spawnPlan,
      logger: args.logger,
      spawnOverride: args.spawnOverride,
    });
    try {
      await initializeAcpConnection({
        connection,
        dialect: args.dialect,
        ...(args.handshakeTimeoutMs !== undefined ? { timeoutMs: args.handshakeTimeoutMs } : {}),
      });
    } catch (error) {
      connection.dispose("handshake failed");
      throw error;
    }
    generationCounter += 1;
    const entry: PoolEntry = {
      connection,
      generation: generationCounter,
      refCount: 0,
      idleTimer: null,
      idleTtlMs: args.dialect.oneProcessPerSession ? 0 : args.idleTtlMs ?? ACP_IDLE_TTL_MS,
    };
    connection.onExit(() => {
      dropEntry(poolKey, entry, "agent process exited");
    });
    entries.set(poolKey, entry);
    return entry;
  };

  return {
    acquire: async (args: AcquireAcpConnectionArgs) => {
      const poolKey = buildAcpPoolKey({
        providerId: args.dialect.providerId,
        cwd: args.spawnPlan.cwd,
        envHash: hashPoolEnv(args.spawnPlan.env, args.poolEnvKeys),
        invocationHash: hashSpawnInvocation(args.spawnPlan),
        privateToken: args.dialect.oneProcessPerSession ? args.sessionToken : null,
      });

      for (;;) {
        const existing = entries.get(poolKey);
        if (existing?.connection.isAlive()) return lease(poolKey, existing);
        if (existing) dropEntry(poolKey, existing, "connection is not alive");

        let inFlight = building.get(poolKey);
        if (!inFlight) {
          inFlight = build(poolKey, args).finally(() => building.delete(poolKey));
          building.set(poolKey, inFlight);
        }
        const built = await inFlight;
        const current = entries.get(poolKey);
        // The connection may have died, or been evicted, while it was building.
        // Loop and rebuild rather than hand out a corpse.
        if (current === built && built.connection.isAlive()) return lease(poolKey, built);
      }
    },
    size: () => entries.size,
    has: (poolKey: string) => entries.get(poolKey)?.connection.isAlive() === true,
    disposeAll: (reason: string) => {
      for (const [poolKey, entry] of [...entries.entries()]) {
        dropEntry(poolKey, entry, reason);
      }
      entries.clear();
    },
  };
}

/** Process-wide pool. W4 uses this instead of creating its own. */
export const acpSessionPool = createAcpSessionPool();
