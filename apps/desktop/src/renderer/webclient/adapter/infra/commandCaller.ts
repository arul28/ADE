import type { SyncRemoteCommandDescriptor } from "../../../../shared/types/sync";
import type { AdeSyncClient } from "../../sync";
import { noteProjectHostUnavailable } from "../../sync/projectHostRecoveryStore";
import { stableCacheKey } from "./cacheKey";
import { createCoalescingReadCache } from "./coalescingReadCache";
import type { AdapterProjectState } from "./projectState";

type Fallback<T> = T | (() => T | Promise<T>);

export type CommandCallOptions<T> = {
  fallback: Fallback<T>;
  /**
   * Read guard, and the default: an omitted flag is a read too. `true` only
   * says it out loud. A mutation has no fallback, so `{ idempotent: false }`
   * cannot be written in this shape.
   */
  idempotent?: true;
  /**
   * The caller needs the host's own answer. When the host cannot give one, the
   * call rejects instead of resolving `fallback` or the last successful read,
   * so an empty or stale result is never taken for the real one.
   */
  authoritative?: boolean;
  requireProject?: boolean;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /**
   * `false` for large one-off reads (history pages, image data): their answer
   * is not kept as the reconnect fallback, which holds up to 500 entries and
   * would otherwise pin hundreds of MB of transcript and image bytes.
   */
  retainLastRead?: false;
};

/**
 * A mutation's call options: no fallback at all.
 *
 * A mutation resolves the host's own answer or rejects — there is no value a
 * caller could pass that would be honest to resolve when the host never took
 * the call. `idempotent: false` selects this shape, and a mutation has no read
 * key, so every branch that would resolve an offline answer rejects before a
 * fallback could be reached. The two shapes are disjoint: a fallback is a read,
 * and `idempotent: false` with a fallback does not compile.
 */
export type CommandMutationCallOptions = {
  idempotent: false;
  /** Same rule as a read's: the host's own answer, or a rejection. */
  authoritative?: boolean;
  requireProject?: boolean;
  timeoutMs?: number;
};

const RECOVERABLE_CODES = new Set([
  "missing_project",
  "project_not_open",
  "unknown_action",
  "unsupported_action",
  "command_rejected",
]);

const TRANSPORT_FAILURE_CODES = new Set([
  "host_unavailable",
  "disconnected",
  "not_connected",
  "connection_lost_outcome_unknown",
  "restoration_missing",
  "timeout",
]);

const READ_CACHE_TTL_MS = 3_000;

/**
 * Raised when a mutation names an action the connected ADE runtime does not
 * serve. Carries the action so a surface can say which capability is missing
 * instead of failing anonymously.
 */
export class UnsupportedRemoteCommandError extends Error {
  readonly code = "unsupported_action";

  constructor(readonly action: string) {
    // Matches the phrasing the explicit `callRequired` fallbacks already use,
    // so every "the host can't do this" failure reads the same way.
    super(`Action '${action}' is unavailable on the connected ADE host. Update ADE on that machine to use it.`);
    this.name = "UnsupportedRemoteCommandError";
  }
}

export class CommandCaller {
  private readonly readCache = createCoalescingReadCache(READ_CACHE_TTL_MS);
  private readonly lastSuccessfulReads = new Map<string, unknown>();
  // Bumped by every invalidation (a write invalidates its namespace), so a read
  // already in flight then does not store its older answer as the reconnect
  // fallback.
  private invalidationEpoch = 0;
  private descriptorSource: readonly SyncRemoteCommandDescriptor[] | null = null;
  private descriptorIndex = new Map<string, SyncRemoteCommandDescriptor>();

  constructor(
    private readonly client: AdeSyncClient,
    private readonly projectState: AdapterProjectState
  ) {}

  invalidateCache(actionPrefixes?: string[]): void {
    this.invalidationEpoch += 1;
    if (!actionPrefixes?.length) {
      this.readCache.clear();
      this.lastSuccessfulReads.clear();
      return;
    }
    this.readCache.invalidate((key) => {
      const actionStart = key.indexOf("\u0000") + 1;
      return actionPrefixes.some((prefix) => key.startsWith(prefix, actionStart));
    });
    for (const key of this.lastSuccessfulReads.keys()) {
      const actionStart = key.indexOf("\u0000") + 1;
      if (actionPrefixes.some((prefix) => key.startsWith(prefix, actionStart))) {
        this.lastSuccessfulReads.delete(key);
      }
    }
  }

  getDescriptor(action: string): SyncRemoteCommandDescriptor | null {
    const descriptors = this.client.getCommandDescriptors();
    // A linear scan per call was fine while only a handful of call sites asked;
    // capability checks ask far more often. Identity alone is NOT a sufficient
    // cache key — a caller that appends to the array it already handed us would
    // keep a stale index and report a served action as unsupported — so the
    // entry count is checked too.
    if (descriptors !== this.descriptorSource || descriptors.length !== this.descriptorIndex.size) {
      this.descriptorSource = descriptors;
      this.descriptorIndex = new Map(descriptors.map((descriptor) => [descriptor.action, descriptor]));
    }
    return this.descriptorIndex.get(action) ?? null;
  }

  hasAction(action: string): boolean {
    return Boolean(this.getDescriptor(action));
  }

  /** A read: a host that cannot answer resolves `fallback`. */
  call<T>(
    action: string,
    args: Record<string, unknown> | undefined,
    options: CommandCallOptions<T>,
  ): Promise<T>;
  /** A mutation: the host's answer, or a rejection. Never a fabricated value. */
  call<T>(
    action: string,
    args: Record<string, unknown> | undefined,
    options: CommandMutationCallOptions,
  ): Promise<T>;
  async call<T>(
    action: string,
    args: Record<string, unknown> = {},
    options: CommandCallOptions<T> | CommandMutationCallOptions,
  ): Promise<T> {
    /**
     * A read's offline answer. A mutation has none: every branch below that
     * would resolve one refuses a mutation first, so reaching this line with
     * no fallback is a contract error rather than an empty result.
     */
    const resolveOfflineAnswer = async (): Promise<T> => {
      if (!("fallback" in options)) throw new UnsupportedRemoteCommandError(action);
      return await resolveFallback(options.fallback);
    };
    const descriptor = this.getDescriptor(action);
    if (!descriptor) {
      // A read the host cannot serve legitimately degrades to its fallback —
      // an empty list, a null summary. A WRITE must not: no request was sent,
      // so resolving the fallback reports a mutation that never happened.
      // (The `idempotent: false` guard below only covers failures AFTER
      // dispatch; this is the case where nothing is dispatched at all.)
      // An authoritative read does not degrade either: its fallback is not the host's answer.
      if (options.idempotent === false || options.authoritative) {
        throw new UnsupportedRemoteCommandError(action);
      }
      return await resolveOfflineAnswer();
    }

    const requireProject = options.requireProject ?? descriptor.scope === "project";
    const projectId = descriptor.scope === "project" ? this.projectState.getProjectId() : null;
    if (requireProject && descriptor.scope === "project" && !projectId) {
      // Same rule as above: nothing was dispatched, so a mutation must reject
      // rather than resolve an answer the host never gave.
      if (options.authoritative || options.idempotent === false) {
        throw new Error(`Action '${action}' needs a project open on the connected ADE host.`);
      }
      return await resolveOfflineAnswer();
    }

    const readKey = options.idempotent !== false
      ? `${projectId ?? "runtime"}\u0000${action}\u0000${stableCacheKey(args)}`
      : null;
    const retainLastRead = readKey !== null && !("retainLastRead" in options && options.retainLastRead === false);
    const send = async (): Promise<T> => {
      const epoch = this.invalidationEpoch;
      const value = (await this.client.sendCommand(action, args, {
        projectId,
        timeoutMs: options.timeoutMs,
      })) as T;
      if (readKey && retainLastRead && epoch === this.invalidationEpoch) this.rememberSuccessfulRead(readKey, value);
      return value;
    };

    let value: T;
    try {
      if (!readKey) {
        value = await send();
      } else {
        // Every idempotent read joins an identical in-flight request: several
        // surfaces polling the same read otherwise each cost a host round-trip.
        // Only the host's answer is shared. A failure reaches every caller and
        // each applies its own fallback below. With no `cacheTtlMs` the entry
        // is dropped the moment it settles, so nothing can go stale.
        // An authoritative read asks the host now, so it never takes a plain
        // read's retained answer.
        // A caller's timeout is part of the request: a short-timeout read never
        // waits on a longer one.
        const flightKey = `${readKey}\u0000${options.authoritative ? "authoritative" : ""}\u0000${options.timeoutMs ?? ""}`;
        // A mutation has no `cacheTtlMs` (and never takes this branch: it has
        // no read key); the read's own option decides how long the answer lives.
        const cacheTtlMs = "fallback" in options ? options.cacheTtlMs : undefined;
        value = await this.readCache.coalesce(flightKey, send, { ttlMs: cacheTtlMs ?? 0 });
      }
    } catch (error) {
      // noteProjectHostUnavailable ignores anything that is not a
      // host_unavailable failure, and anything from a client that is not the
      // active machine's, so it needs no guard of its own here.
      noteProjectHostUnavailable(error, this.client);
      // A mutation that reached the transport can have an unknown outcome.
      // Never fabricate success from its UI fallback: callers such as the
      // chat composer rely on rejection to preserve the user's draft.
      if (!readKey) throw error;
      // An authoritative read rejects too: neither the last read nor the fallback is the host's answer.
      if (options.authoritative) throw error;
      if (isTransportFailure(error)) {
        if (this.lastSuccessfulReads.has(readKey)) {
          return this.lastSuccessfulReads.get(readKey) as T;
        }
        // Without prior data, an empty fallback would turn a transient
        // reconnect into a false empty state. Let the mounted surface retain
        // its current data and render the connection status instead.
        throw error;
      }
      if (isRecoverable(error)) return await resolveOfflineAnswer();
      throw error;
    } finally {
      if (!readKey) {
        // A write: a read of its namespace that started before it settled, and
        // the last good answer kept for reconnects, both predate it. Later
        // callers read the host anew.
        this.invalidateCache([`${action.split(".")[0]}.`]);
      }
    }
    return value;
  }

  private rememberSuccessfulRead(key: string, value: unknown): void {
    this.lastSuccessfulReads.delete(key);
    this.lastSuccessfulReads.set(key, value);
    while (this.lastSuccessfulReads.size > 500) {
      const oldest = this.lastSuccessfulReads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastSuccessfulReads.delete(oldest);
    }
  }
}

async function resolveFallback<T>(fallback: Fallback<T>): Promise<T> {
  if (typeof fallback === "function") {
    return await (fallback as () => T | Promise<T>)();
  }
  return fallback;
}

function isRecoverable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (RECOVERABLE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("missing_project") ||
    message.includes("project_not_open") ||
    message.includes("unsupported")
  );
}

function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (TRANSPORT_FAILURE_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("host_unavailable")
    || message.includes("not connected")
    || message.includes("connection lost")
    || message.includes("reconnecting")
    || message.includes("timed out")
  );
}
