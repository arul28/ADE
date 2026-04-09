import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  createOpencodeServer,
  type Config as OpenCodeConfig,
} from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger";
import { stableStringify } from "../shared/utils";

export type OpenCodeServerLeaseKind = "shared" | "dedicated";
export type OpenCodeServerOwnerKind = "inventory" | "oneshot" | "chat" | "coordinator";
export type OpenCodeServerShutdownReason =
  | "handle_close"
  | "idle_ttl"
  | "paused_run"
  | "ended_session"
  | "model_switch"
  | "project_close"
  | "budget_eviction"
  | "shutdown"
  | "config_changed"
  | "error";

type OpenCodeServerInstance = Awaited<ReturnType<typeof createOpencodeServer>>;

type OpenCodeServerEntry = {
  id: string;
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId: string | null;
  configFingerprint: string;
  server: OpenCodeServerInstance;
  idleTtlMs: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  refCount: number;
  busy: boolean;
  onEvict: ((reason: OpenCodeServerShutdownReason) => void) | null;
  startedAt: number;
  lastUsedAt: number;
};

export type OpenCodeServerLease = {
  url: string;
  release(reason?: OpenCodeServerShutdownReason): void;
  close(reason?: OpenCodeServerShutdownReason): void;
  touch(): void;
  setBusy(busy: boolean): void;
  setEvictionHandler(handler: ((reason: OpenCodeServerShutdownReason) => void) | null): void;
};

export type OpenCodeRuntimeDiagnosticsEntry = {
  id: string;
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId: string | null;
  configFingerprint: string;
  url: string;
  busy: boolean;
  refCount: number;
  startedAt: number;
  lastUsedAt: number;
};

const PORT_RETRY_ATTEMPTS = 3;
const DEFAULT_SHARED_IDLE_TTL_MS = 60_000;
const MAX_DEDICATED_OPENCODE_SERVERS = 6;

const sharedEntries = new Map<string, OpenCodeServerEntry>();
const dedicatedEntries = new Map<string, OpenCodeServerEntry>();
const inFlightEntries = new Map<string, Promise<OpenCodeServerEntry>>();
const acquireQueues = new Map<string, Array<() => void>>();

function serializeConfigFingerprint(config: OpenCodeConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

async function withAcquireLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = acquireQueues.get(lockKey);
  if (queue) {
    queue.push(release);
    await gate;
  } else {
    acquireQueues.set(lockKey, [release]);
    release();
  }

  try {
    return await fn();
  } finally {
    const currentQueue = acquireQueues.get(lockKey);
    if (currentQueue) {
      currentQueue.shift();
      const next = currentQueue[0];
      if (next) {
        next();
      } else {
        acquireQueues.delete(lockKey);
      }
    }
  }
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an OpenCode port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function isPortConflict(error: unknown): boolean {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "EADDRINUSE") return true;
    if (error instanceof Error) {
      return error.message.includes("EADDRINUSE") || error.message.includes("address already in use");
    }
  }
  return false;
}

async function createOpencodeServerWithRetry(
  config: OpenCodeConfig,
): Promise<OpenCodeServerInstance> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_RETRY_ATTEMPTS; attempt += 1) {
    const port = await findAvailablePort();
    try {
      return await createOpencodeServer({ port, config });
    } catch (error) {
      lastError = error;
      if (!isPortConflict(error)) throw error;
    }
  }
  throw lastError;
}

function logRuntimeEvent(
  logger: Logger | null | undefined,
  event: string,
  entry: OpenCodeServerEntry,
  extra: Record<string, unknown> = {},
): void {
  logger?.info(event, {
    leaseKind: entry.leaseKind,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    configFingerprint: entry.configFingerprint,
    url: entry.server.url,
    ...extra,
  });
}

function clearIdleTimer(entry: OpenCodeServerEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function removeEntry(entry: OpenCodeServerEntry): void {
  clearIdleTimer(entry);
  if (entry.leaseKind === "shared") {
    sharedEntries.delete(entry.key);
    return;
  }
  dedicatedEntries.delete(entry.key);
}

function shutdownEntry(
  entry: OpenCodeServerEntry,
  reason: OpenCodeServerShutdownReason,
  logger?: Logger | null,
): void {
  removeEntry(entry);
  try {
    entry.server.close();
  } catch {
    // ignore shutdown failures
  }
  logRuntimeEvent(logger, "opencode.server_shutdown", entry, { reason });
}

function scheduleSharedIdleTimer(
  entry: OpenCodeServerEntry,
  logger?: Logger | null,
): void {
  clearIdleTimer(entry);
  if (!entry.idleTtlMs || entry.refCount > 0) return;
  entry.idleTimer = setTimeout(() => {
    const current = sharedEntries.get(entry.key);
    if (!current || current.id !== entry.id || current.refCount > 0) return;
    shutdownEntry(current, "idle_ttl", logger);
  }, entry.idleTtlMs);
  if (entry.idleTimer.unref) entry.idleTimer.unref();
}

function buildLease(entry: OpenCodeServerEntry, logger?: Logger | null): OpenCodeServerLease {
  let released = false;
  const touch = (): void => {
    entry.lastUsedAt = Date.now();
  };
  const release = (reason: OpenCodeServerShutdownReason = "handle_close"): void => {
    if (released) return;
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = Date.now();
    logRuntimeEvent(logger, "opencode.server_released", entry, { reason, refCount: entry.refCount });
    if (entry.leaseKind === "shared") {
      if (entry.refCount === 0 && reason === "error") {
        shutdownEntry(entry, reason, logger);
        return;
      }
      scheduleSharedIdleTimer(entry, logger);
      return;
    }
    if (entry.refCount === 0) {
      shutdownEntry(entry, reason, logger);
    }
  };
  touch();
  return {
    url: entry.server.url,
    release,
    close(reason = "handle_close") {
      release(reason);
    },
    touch,
    setBusy(busy: boolean) {
      entry.busy = busy;
      entry.lastUsedAt = Date.now();
    },
    setEvictionHandler(handler) {
      entry.onEvict = handler;
    },
  };
}

function pickDedicatedEvictionCandidate(excludeKey?: string): OpenCodeServerEntry | null {
  let oldest: OpenCodeServerEntry | null = null;
  for (const entry of dedicatedEntries.values()) {
    if (entry.key === excludeKey) continue;
    if (entry.busy || entry.refCount > 0) continue;
    if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
      oldest = entry;
    }
  }
  return oldest;
}

function enforceDedicatedBudget(
  logger?: Logger | null,
  excludeKey?: string,
): void {
  if (dedicatedEntries.size < MAX_DEDICATED_OPENCODE_SERVERS) return;
  const candidate = pickDedicatedEvictionCandidate(excludeKey);
  if (!candidate) {
    throw new Error(
      `OpenCode runtime limit reached (${MAX_DEDICATED_OPENCODE_SERVERS} dedicated servers). Close or wait for an idle chat/mission runtime before starting another OpenCode session.`,
    );
  }
  candidate.onEvict?.("budget_eviction");
  const stillPresent = dedicatedEntries.get(candidate.key);
  if (stillPresent) {
    if (stillPresent.refCount > 0 || stillPresent.busy) {
      throw new Error(
        `OpenCode runtime limit reached (${MAX_DEDICATED_OPENCODE_SERVERS} dedicated servers). The selected eviction candidate is still leased and cannot be reclaimed safely.`,
      );
    }
    shutdownEntry(stillPresent, "budget_eviction", logger);
  }
}

async function createEntry(args: {
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  config: OpenCodeConfig;
  configFingerprint: string;
  idleTtlMs?: number | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerEntry> {
  const inflightKey = `${args.leaseKind}:${args.key}:${args.configFingerprint}`;
  const existingPromise = inFlightEntries.get(inflightKey);
  if (existingPromise) return await existingPromise;

  const createPromise = (async () => {
    const server = await createOpencodeServerWithRetry(args.config);
    const entry: OpenCodeServerEntry = {
      id: randomUUID(),
      key: args.key,
      leaseKind: args.leaseKind,
      ownerKind: args.ownerKind,
      ownerId: args.ownerId?.trim() || null,
      configFingerprint: args.configFingerprint,
      server,
      idleTtlMs: args.leaseKind === "shared" ? args.idleTtlMs ?? DEFAULT_SHARED_IDLE_TTL_MS : null,
      idleTimer: null,
      refCount: 0,
      busy: false,
      onEvict: null,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    logRuntimeEvent(args.logger, "opencode.server_started", entry);
    return entry;
  })().finally(() => {
    inFlightEntries.delete(inflightKey);
  });

  inFlightEntries.set(inflightKey, createPromise);
  return await createPromise;
}

export async function acquireSharedOpenCodeServer(args: {
  config: OpenCodeConfig;
  key?: string;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  idleTtlMs?: number | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const configFingerprint = serializeConfigFingerprint(args.config);
  const key = args.key?.trim() || configFingerprint;
  return await withAcquireLock(`shared:${key}`, async () => {
    while (true) {
      const existing = sharedEntries.get(key);
      if (existing && existing.configFingerprint === configFingerprint) {
        clearIdleTimer(existing);
        existing.refCount += 1;
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_reused", existing, { refCount: existing.refCount });
        return buildLease(existing, args.logger);
      }
      if (existing && existing.refCount > 0) {
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_config_mismatch_retained", existing, {
          requestedConfigFingerprint: configFingerprint,
          refCount: existing.refCount,
        });
        existing.refCount += 1;
        return buildLease(existing, args.logger);
      }
      if (existing) {
        shutdownEntry(existing, "config_changed", args.logger);
      }
      const entry = await createEntry({
        key,
        leaseKind: "shared",
        ownerKind: args.ownerKind ?? "oneshot",
        ownerId: args.ownerId,
        config: args.config,
        configFingerprint,
        idleTtlMs: args.idleTtlMs,
        logger: args.logger,
      });
      if (entry.configFingerprint !== configFingerprint) {
        shutdownEntry(entry, "config_changed", args.logger);
        continue;
      }
      entry.refCount = 1;
      sharedEntries.set(key, entry);
      return buildLease(entry, args.logger);
    }
  });
}

export async function acquireDedicatedOpenCodeServer(args: {
  ownerKey: string;
  config: OpenCodeConfig;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const ownerKey = args.ownerKey.trim();
  if (!ownerKey.length) {
    throw new Error("ownerKey is required for dedicated OpenCode servers.");
  }
  const configFingerprint = serializeConfigFingerprint(args.config);
  return await withAcquireLock(`dedicated:${ownerKey}`, async () => {
    while (true) {
      const existing = dedicatedEntries.get(ownerKey);
      if (existing && existing.configFingerprint === configFingerprint) {
        existing.refCount += 1;
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_reused", existing, { refCount: existing.refCount });
        return buildLease(existing, args.logger);
      }
      if (existing && existing.refCount > 0) {
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_config_mismatch_retained", existing, {
          requestedConfigFingerprint: configFingerprint,
          refCount: existing.refCount,
        });
        existing.refCount += 1;
        return buildLease(existing, args.logger);
      }
      if (existing) {
        shutdownEntry(existing, "config_changed", args.logger);
      }
      enforceDedicatedBudget(args.logger, ownerKey);
      const entry = await createEntry({
        key: ownerKey,
        leaseKind: "dedicated",
        ownerKind: args.ownerKind,
        ownerId: args.ownerId,
        config: args.config,
        configFingerprint,
        logger: args.logger,
      });
      if (entry.configFingerprint !== configFingerprint) {
        shutdownEntry(entry, "config_changed", args.logger);
        continue;
      }
      entry.refCount = 1;
      dedicatedEntries.set(ownerKey, entry);
      return buildLease(entry, args.logger);
    }
  });
}

export function shutdownOpenCodeServers(filter: {
  leaseKind?: OpenCodeServerLeaseKind;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
} = {}): void {
  const matches = (entry: OpenCodeServerEntry): boolean => {
    if (filter.leaseKind && entry.leaseKind !== filter.leaseKind) return false;
    if (filter.ownerKind && entry.ownerKind !== filter.ownerKind) return false;
    if (filter.ownerId !== undefined && entry.ownerId !== (filter.ownerId?.trim() || null)) return false;
    return true;
  };
  for (const entry of [...sharedEntries.values(), ...dedicatedEntries.values()]) {
    if (!matches(entry)) continue;
    shutdownEntry(entry, "shutdown");
  }
}

export function getOpenCodeRuntimeDiagnostics(): {
  sharedCount: number;
  dedicatedCount: number;
  entries: OpenCodeRuntimeDiagnosticsEntry[];
} {
  const entries = [...sharedEntries.values(), ...dedicatedEntries.values()].map((entry) => ({
    id: entry.id,
    key: entry.key,
    leaseKind: entry.leaseKind,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    configFingerprint: entry.configFingerprint,
    url: entry.server.url,
    busy: entry.busy,
    refCount: entry.refCount,
    startedAt: entry.startedAt,
    lastUsedAt: entry.lastUsedAt,
  }));
  return {
    sharedCount: sharedEntries.size,
    dedicatedCount: dedicatedEntries.size,
    entries,
  };
}

export function __resetOpenCodeServerManagerForTests(): void {
  shutdownOpenCodeServers();
  inFlightEntries.clear();
  acquireQueues.clear();
}
