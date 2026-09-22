// ---------------------------------------------------------------------------
// Model manifest service — keeps the registry's model directory current
// without a release.
//
// Sources, best first: the copy on GitHub `main`, the last good copy on disk,
// the copy bundled into this build. A disk copy older than the bundled one is
// ignored, so upgrading ADE never regresses to a stale cached directory.
//
// Cost: one conditional GET (If-None-Match) every POLL_INTERVAL_MS, plus an
// opportunistic check when a model picker asks for the catalog and the last
// check is older than PICKER_STALE_MS. An unchanged manifest answers 304 with
// no body. Nothing ever waits on the network: callers read the registry, and a
// newer manifest lands in the background and notifies catalog caches.
// ---------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MODEL_MANIFEST_REMOTE_URL,
  modelManifestUpdatedAtMs,
  parseModelManifest,
  type ModelManifest,
} from "../../../shared/modelManifest";
import { applyModelManifest, BUNDLED_MODEL_MANIFEST, getActiveModelManifest } from "../../../shared/modelRegistry";

const FETCH_TIMEOUT_MS = 10_000;
/** Background poll. raw.githubusercontent.com caches for ~5 min anyway. */
const POLL_INTERVAL_MS = 10 * 60_000;
/** A picker open re-checks when the last check is older than this. */
const PICKER_STALE_MS = 3 * 60_000;
/** After a failed fetch, wait this long before trying again. */
const RETRY_BACKOFF_MS = 5 * 60_000;
const cacheFilePath = (): string => join(homedir(), ".ade", "model-manifest.json");

type CachedManifest = { fetchedAtMs: number; etag: string | null; manifest: unknown };

type ModelManifestLogger = {
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
};

let initialized = false;
let enabled = true;
let adeVersion: string | null = null;
let logger: ModelManifestLogger | null = null;
let etag: string | null = null;
let lastCheckedAtMs = 0;
let lastFailureAtMs = 0;
let inFlight: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Apply a manifest only when it moves the directory forward: never older than
 * the bundled copy, never older than (or identical to) what is active.
 */
type ApplyOutcome = "applied" | "current" | "rejected";

function applyIfNewer(manifest: ModelManifest, source: string): ApplyOutcome {
  const incomingAt = modelManifestUpdatedAtMs(manifest);
  if (incomingAt < modelManifestUpdatedAtMs(BUNDLED_MODEL_MANIFEST)) return "rejected";
  const active = getActiveModelManifest();
  if (active && active.adeVersion === adeVersion) {
    const activeAt = modelManifestUpdatedAtMs(active.manifest);
    if (activeAt > incomingAt) return "rejected";
    if (activeAt === incomingAt) return "current";
  }
  const result = applyModelManifest(manifest, { adeVersion });
  if (!result.applied) {
    logger?.warn("ai.model_manifest.apply_failed", { source, errors: result.errors });
    return "rejected";
  }
  logger?.info("ai.model_manifest.applied", {
    source,
    updatedAt: manifest.updatedAt,
    added: result.added,
    patched: result.patched.length,
    skipped: result.skipped,
    ...(result.errors.length ? { errors: result.errors } : {}),
  });
  return "applied";
}

async function loadCachedManifest(): Promise<void> {
  try {
    const cached = JSON.parse(await readFile(cacheFilePath(), "utf-8")) as CachedManifest;
    const parsed = parseModelManifest(cached.manifest);
    if (!parsed.ok) return;
    etag = typeof cached.etag === "string" ? cached.etag : null;
    lastCheckedAtMs = Number.isFinite(cached.fetchedAtMs) ? cached.fetchedAtMs : 0;
    applyIfNewer(parsed.manifest, "disk");
  } catch {
    // No cache yet, or unreadable — the bundled manifest is already applied.
  }
}

async function persistManifest(manifest: unknown): Promise<void> {
  try {
    const cacheFile = cacheFilePath();
    await mkdir(join(homedir(), ".ade"), { recursive: true });
    const tempFile = `${cacheFile}.${process.pid}.tmp`;
    const payload: CachedManifest = { fetchedAtMs: lastCheckedAtMs, etag, manifest };
    await writeFile(tempFile, JSON.stringify(payload), "utf-8");
    await rename(tempFile, cacheFile);
  } catch {
    // Non-critical: the next launch just starts from the bundled copy.
  }
}

async function fetchRemoteManifest(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(MODEL_MANIFEST_REMOTE_URL, {
      signal: controller.signal,
      headers: etag ? { "If-None-Match": etag } : {},
    });
    lastCheckedAtMs = Date.now();
    if (response.status === 304) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json() as unknown;
    const parsed = parseModelManifest(raw);
    if (!parsed.ok) {
      logger?.warn("ai.model_manifest.invalid_remote", { errors: parsed.errors.slice(0, 10) });
      return;
    }
    // Only a copy that is (or matches) the active directory replaces the disk
    // cache; an older or unappliable one must not evict the last good copy.
    if (applyIfNewer(parsed.manifest, "remote") === "rejected") return;
    etag = response.headers.get("etag");
    await persistManifest(raw);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check GitHub for a newer manifest. Never throws and never overlaps; a
 * failure backs off so an offline machine does not retry on every picker open.
 */
export function refreshModelManifest(options?: { maxAgeMs?: number }): Promise<void> {
  if (!initialized || !enabled) return Promise.resolve();
  if (inFlight) return inFlight;
  const now = Date.now();
  const maxAgeMs = options?.maxAgeMs ?? 0;
  if (maxAgeMs > 0 && now - lastCheckedAtMs < maxAgeMs) return Promise.resolve();
  if (now - lastFailureAtMs < RETRY_BACKOFF_MS) return Promise.resolve();
  inFlight = fetchRemoteManifest()
    .catch((error) => {
      lastFailureAtMs = Date.now();
      logger?.warn("ai.model_manifest.fetch_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Fire-and-forget check for surfaces about to show models (pickers). */
export function refreshModelManifestIfStale(): void {
  void refreshModelManifest({ maxAgeMs: PICKER_STALE_MS });
}

/**
 * Start the service once per process. Later calls are no-ops, so every
 * project's AI service can call it. `fetchRemote: false` still applies a
 * cached disk copy but never touches the network.
 */
export function initializeModelManifestService(args: {
  adeVersion: string | null;
  logger?: ModelManifestLogger;
  fetchRemote?: boolean;
}): void {
  if (initialized) {
    // One process can host an offline runtime first and an agent runtime
    // later; the later caller may turn fetching on, never off.
    if (args.fetchRemote !== false && !enabled) {
      enabled = true;
      logger ??= args.logger ?? null;
      startPolling();
    }
    return;
  }
  initialized = true;
  adeVersion = args.adeVersion?.trim() || null;
  logger = args.logger ?? null;
  enabled = args.fetchRemote !== false;
  // Re-gate the bundled copy for this build's real version.
  applyModelManifest(getActiveModelManifest()?.manifest ?? BUNDLED_MODEL_MANIFEST, { adeVersion });
  void loadCachedManifest().then(() => {
    if (enabled) startPolling();
  });
}

function startPolling(): void {
  void refreshModelManifest();
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshModelManifest(), POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

/** Test/cleanup hook. */
export function shutdownModelManifestService(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  initialized = false;
  enabled = true;
  adeVersion = null;
  logger = null;
  etag = null;
  lastCheckedAtMs = 0;
  lastFailureAtMs = 0;
  inFlight = null;
}
