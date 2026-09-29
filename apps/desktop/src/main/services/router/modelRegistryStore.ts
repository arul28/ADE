/**
 * This machine's copy of the model registry.
 *
 * The account directory Worker builds one registry snapshot a day and serves
 * it only to signed-in ADE accounts (`GET /router/registry`). This store keeps
 * the newest copy on disk at `<adeHome>/router/registry.json`, so the router
 * works offline and after a restart, and asks the Worker again at most every
 * 12 hours (30 minutes after a failure). A conditional request (ETag) makes an
 * unchanged day cost almost nothing.
 *
 * `ADE_MODEL_REGISTRY_FILE` points the store at a local snapshot file instead
 * of the Worker, for development before a deploy.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { writeFileAtomic } from "../state/durableFile";
import { isModelRegistrySnapshot, type ModelRegistrySnapshot } from "../../../shared/routerRegistry";

const REFRESH_INTERVAL_MS = 12 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;

export type ModelRegistryFetchResult =
  | { status: "ok"; snapshot: unknown; etag: string | null }
  | { status: "not_modified" }
  | { status: "error"; message: string };

/** Asks the Worker for the snapshot. `etag` is the copy on disk, if any. */
export type ModelRegistryFetcher = (etag: string | null) => Promise<ModelRegistryFetchResult>;

export type ModelRegistryStatus = {
  source: "worker" | "file";
  generatedAt: string | null;
  fetchedAt: string | null;
  lastError: string | null;
  models: number;
  agents: number;
};

export type ModelRegistryStore = {
  /** The newest snapshot on this machine, or null when there is none yet. */
  getSnapshot(): ModelRegistrySnapshot | null;
  /** Fetches when due (or when `force`). Never throws. */
  refresh(options?: { force?: boolean }): Promise<ModelRegistryStatus>;
  status(): ModelRegistryStatus;
};

type CacheFile = { etag: string | null; fetchedAt: string; snapshot: ModelRegistrySnapshot };

export function createModelRegistryStore(args: {
  dir: string;
  fetchSnapshot: ModelRegistryFetcher;
  logger?: Pick<Logger, "warn" | "info"> | null;
  nowMs?: () => number;
  /** A local snapshot file that replaces the Worker. */
  overrideFile?: string | null;
}): ModelRegistryStore {
  const now = args.nowMs ?? Date.now;
  const cachePath = path.join(args.dir, "registry.json");
  let cache: CacheFile | null | undefined;
  let lastAttemptMs = 0;
  let lastError: string | null = null;
  let inFlight: Promise<ModelRegistryStatus> | null = null;

  const readOverride = (): ModelRegistrySnapshot | null => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(args.overrideFile!, "utf8"));
      if (isModelRegistrySnapshot(parsed)) return parsed;
      lastError = "the registry file is not a model registry snapshot";
    } catch (error) {
      lastError = getErrorMessage(error);
    }
    return null;
  };

  const load = (): CacheFile | null => {
    if (cache !== undefined) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<CacheFile>;
      cache = parsed && isModelRegistrySnapshot(parsed.snapshot)
        ? { etag: parsed.etag ?? null, fetchedAt: parsed.fetchedAt ?? new Date(0).toISOString(), snapshot: parsed.snapshot }
        : null;
    } catch {
      cache = null;
    }
    return cache;
  };

  const save = (next: CacheFile): void => {
    cache = next;
    try {
      fs.mkdirSync(args.dir, { recursive: true });
      // The canonical atomic writer: it replaces the target through a rename
      // (with the Windows EPERM/EACCES/EBUSY copy fallback) and names its temp
      // file so a crashed write is swept by `cleanupAbandonedTempFiles`.
      writeFileAtomic(cachePath, JSON.stringify(next));
    } catch (error) {
      args.logger?.warn("router.registry_cache_write_failed", { error: getErrorMessage(error) });
    }
  };

  const status = (): ModelRegistryStatus => {
    const snapshot = args.overrideFile ? readOverride() : load()?.snapshot ?? null;
    return {
      source: args.overrideFile ? "file" : "worker",
      generatedAt: snapshot?.generatedAt ?? null,
      fetchedAt: args.overrideFile ? null : load()?.fetchedAt ?? null,
      lastError,
      models: snapshot?.models.length ?? 0,
      agents: snapshot?.agents.length ?? 0,
    };
  };

  const doRefresh = async (): Promise<ModelRegistryStatus> => {
    lastAttemptMs = now();
    const current = load();
    let result: ModelRegistryFetchResult;
    try {
      result = await args.fetchSnapshot(current?.etag ?? null);
    } catch (error) {
      result = { status: "error", message: getErrorMessage(error) };
    }
    if (result.status === "ok") {
      if (isModelRegistrySnapshot(result.snapshot)) {
        save({ etag: result.etag, fetchedAt: new Date(now()).toISOString(), snapshot: result.snapshot });
        lastError = null;
      } else {
        lastError = "the registry answer is not a snapshot this ADE version reads";
      }
    } else if (result.status === "not_modified") {
      if (current) save({ ...current, fetchedAt: new Date(now()).toISOString() });
      lastError = null;
    } else {
      lastError = result.message;
      args.logger?.info("router.registry_refresh_failed", { error: result.message });
    }
    return status();
  };

  return {
    getSnapshot() {
      if (args.overrideFile) return readOverride();
      return load()?.snapshot ?? null;
    },
    refresh(options = {}) {
      if (args.overrideFile) return Promise.resolve(status());
      const current = load();
      const fetchedMs = current ? Date.parse(current.fetchedAt) : 0;
      const due = options.force
        || !current
        || now() - fetchedMs >= REFRESH_INTERVAL_MS;
      const backingOff = !options.force && lastError != null && now() - lastAttemptMs < RETRY_AFTER_FAILURE_MS;
      if (!due || backingOff) return Promise.resolve(status());
      inFlight ??= doRefresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    status,
  };
}

/**
 * A fetcher for the Worker route. `getToken` returns the account bearer or
 * throws when the machine is not signed in.
 */
export function createWorkerRegistryFetcher(args: {
  baseUrl: () => string | null;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ModelRegistryFetcher {
  return async (etag) => {
    const base = args.baseUrl()?.replace(/\/+$/, "");
    if (!base) return { status: "error", message: "No ADE account directory is configured." };
    let token: string;
    try {
      token = await args.getToken();
    } catch (error) {
      return { status: "error", message: `Sign in to ADE to use the model router (${getErrorMessage(error)}).` };
    }
    const doFetch = args.fetchImpl ?? fetch;
    const response = await doFetch(`${base}/router/registry`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(etag ? { "if-none-match": etag } : {}),
      },
      signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
    });
    if (response.status === 304) return { status: "not_modified" };
    if (!response.ok) return { status: "error", message: `The registry answered HTTP ${response.status}.` };
    return { status: "ok", snapshot: await response.json(), etag: response.headers.get("etag") };
  };
}
