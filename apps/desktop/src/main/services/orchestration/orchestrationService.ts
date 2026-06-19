import { promises as fsp, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import chokidar, { type FSWatcher } from "chokidar";

import {
  ORCHESTRATION_MANIFEST_VERSION,
  ORCHESTRATION_EVENT_CHANNEL,
  ORCHESTRATION_SPAWN_BRIEF_REQUIRED_SECTIONS,
  type ManifestPatchOp,
  type OrchestrationEventPayload,
  type OrchestrationManifest,
  type OrchestrationManifestPatchRequest,
  type OrchestrationManifestPatchResponse,
  type OrchestrationRole,
  type OrchestrationRunSummary,
  type OrchestrationAsset,
  type OrchestrationPlanAppendRequest,
  type OrchestrationPlanWriteRequest,
  type OrchestrationAssetRegisterRequest,
  type OrchestrationBundleReadResponse,
  type OrchestrationManifestSectionReadResponse,
  type ManifestSection,
  type OrchestrationClaimTaskRequest,
  type OrchestrationReleaseTaskRequest,
  type OrchestrationRecordValidationRunRequest,
  type OrchestrationRunCreateRequest,
  type OrchestrationRunCreateResponse,
  type OrchestrationTaskStatus,
  type PlanningIntakeArtifact,
  type PlanningRoundKind,
  type PlanningRoundRecord,
  type PlanningStage,
  type PlanSpecApprovalState,
  type ValidationFinding,
} from "../../../shared/types/orchestration";
import {
  checkPatchOp,
  extractTaskIdFromPath,
  isTaskHumanOverridePatch,
  isTaskStatusDonePatch,
  isUserOverrideEntryAppend,
  isValidationGateRequiredOff,
  taskValidationGatesSatisfied,
} from "./patchPolicy";
import { applyPatches } from "./applyPatches";
import {
  normalizeManifestShape,
  validateManifestShape,
  buildPhaseTransitionOpsAfterTaskRelease,
  inferValidationRerunSupersedes,
  mergeSupersedes,
  taskSupersedesIds,
  createInitialPlanningState,
  createInitialPlanSpec,
} from "./manifestNormalization";
import {
  hasExplicitValidationWaiver,
  hasOrchestrationModelRouting,
  isExplicitValidationWaiverEntry,
} from "./runtimeProfile";

// Lightweight async mutex — small, dependency-free, FIFO. Replicates the
// pattern used elsewhere in agentChatService.ts so behaviour is consistent.
class AsyncMutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn());
    // Swallow errors in the chain so a single failure doesn't poison the lock
    this.chain = next.catch(() => undefined);
    return next;
  }
}

class OrchestrationPersistConflictError extends Error {
  readonly onDisk: OrchestrationManifest;
  constructor(onDisk: OrchestrationManifest) {
    super("manifest on disk is newer than the in-flight write");
    this.name = "OrchestrationPersistConflictError";
    this.onDisk = onDisk;
  }
}

const MANIFEST_FILE = "manifest.json";
const PLAN_FILE = "plan.md";
const GEN_FILE = ".gen";
const HEARTBEATS_FILE = "heartbeats.json";
const INDEX_FILE = "index.json";
const HISTORY_RING_LIMIT = 50;
const SELF_WRITE_WINDOW_MS = 1_000;
const WATCHER_DEBOUNCE_MS = 50;
const WATCHER_IDLE_CLOSE_MS = 30_000;
const ORCHESTRATION_INDEX_VERSION = 1;
const RUN_LIST_DEFAULT_LIMIT = 100;
const RUN_LIST_MAX_LIMIT = 250;
const RUN_SUSPENDED_MESSAGE =
  "orchestration run is suspended (bundle changed externally); re-open the run or restore the correct branch";
type WatcherFileKind = "manifest" | "plan";
type WatcherDebounceTimers = Partial<Record<WatcherFileKind, NodeJS.Timeout>>;

class OrchestrationRunSuspendedError extends Error {
  constructor() {
    super(RUN_SUSPENDED_MESSAGE);
    this.name = "OrchestrationRunSuspendedError";
  }
}

export type OrchestrationServiceEvents = {
  event: (payload: OrchestrationEventPayload) => void;
};

type RunRuntime = {
  runId: string;
  bundlePath: string;
  manifest: OrchestrationManifest | null;
  planMd: string | null;
  mutex: AsyncMutex;
  watcher: FSWatcher | null;
  refCount: number;
  recentSelfWriteUntil: number;
  watcherDebounceTimers: WatcherDebounceTimers;
  watcherIdleTimer: NodeJS.Timeout | null;
  suspended: boolean;
};

type RunIndexEntry = {
  runId: string;
  laneId: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  goalSummary: string;
  currentPhase: OrchestrationRunSummary["currentPhase"];
  etag: string;
  bundlePath: string;
  status: OrchestrationRunSummary["status"];
  agentCount: number;
  taskCount: number;
};

type RunIndex = {
  version: 1;
  runs: RunIndexEntry[];
};

export type OrchestrationServiceDeps = {
  /** Resolve a lane id to its worktree absolute path. */
  resolveLaneWorktree: (laneId: string) => string | undefined;
  /** Override clock for testing. */
  now?: () => Date;
};

export function createOrchestrationService(deps: OrchestrationServiceDeps) {
  const emitter = new EventEmitter();
  const runs = new Map<string, RunRuntime>();
  const laneIndexMutexes = new Map<string, AsyncMutex>();
  const now = deps.now ?? (() => new Date());

  function nowIso(): string {
    return now().toISOString();
  }

  function orchestrationDirForLane(laneId: string): string {
    const worktree = deps.resolveLaneWorktree(laneId);
    if (!worktree) {
      throw new Error(`unknown laneId ${laneId} — cannot resolve worktree`);
    }
    return path.join(worktree, ".ade", "orchestration");
  }

  function bundleRootFor(laneId: string, runId: string): string {
    return path.join(orchestrationDirForLane(laneId), runId);
  }

  async function ensureBundleDir(bundlePath: string): Promise<void> {
    await Promise.all([
      fsp.mkdir(path.join(bundlePath, "artifacts", "ui"), { recursive: true }),
      fsp.mkdir(path.join(bundlePath, "artifacts", "evidence"), { recursive: true }),
    ]);
  }

  async function readServerGeneration(bundlePath: string): Promise<number> {
    const genPath = path.join(bundlePath, GEN_FILE);
    try {
      const raw = await fsp.readFile(genPath, "utf-8");
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    } catch {
      // missing file is fine; treat as zero
    }
    return 0;
  }

  async function writeServerGeneration(
    bundlePath: string,
    gen: number,
  ): Promise<void> {
    const genPath = path.join(bundlePath, GEN_FILE);
    await atomicWrite(genPath, `${gen}\n`);
  }

  async function readHeartbeatLiveness(bundlePath: string): Promise<Record<string, string>> {
    try {
      const raw = await fsp.readFile(path.join(bundlePath, HEARTBEATS_FILE), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [sessionId, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value.trim()) out[sessionId] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function writeHeartbeatLiveness(bundlePath: string, heartbeats: Record<string, string>): Promise<void> {
    await atomicWrite(path.join(bundlePath, HEARTBEATS_FILE), `${JSON.stringify(heartbeats, null, 2)}\n`);
  }

  function applyHeartbeatLiveness(
    manifest: OrchestrationManifest,
    heartbeats: Record<string, string>,
  ): OrchestrationManifest {
    if (!Object.keys(heartbeats).length) return manifest;
    const next = structuredClone(manifest) as OrchestrationManifest;
    for (const agent of next.agents) {
      const lastHeartbeatAt = heartbeats[agent.sessionId];
      if (lastHeartbeatAt) agent.lastHeartbeatAt = lastHeartbeatAt;
    }
    return next;
  }

  async function atomicWrite(
    target: string,
    contents: string,
    options?: { beforeCommit?: () => Promise<void> },
  ): Promise<void> {
    const dir = path.dirname(target);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`;
    const handle = await fsp.open(tmp, "w");
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (options?.beforeCommit) {
        await options.beforeCommit();
      }
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  function getLaneIndexMutex(laneId: string): AsyncMutex {
    let mutex = laneIndexMutexes.get(laneId);
    if (!mutex) {
      mutex = new AsyncMutex();
      laneIndexMutexes.set(laneId, mutex);
    }
    return mutex;
  }

  function indexPathForLane(laneId: string): string {
    return path.join(orchestrationDirForLane(laneId), INDEX_FILE);
  }

  function runIndexEntryFromManifest(
    manifest: OrchestrationManifest,
    status: OrchestrationRunSummary["status"] = "active",
  ): RunIndexEntry {
    return {
      runId: manifest.runId,
      laneId: manifest.laneId,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      title: manifest.title,
      goalSummary: manifest.goalSummary,
      currentPhase: manifest.currentPhase,
      etag: manifest.etag,
      bundlePath: manifest.bundlePath,
      status,
      agentCount: manifest.agents.length,
      taskCount: manifest.tasks.length,
    };
  }

  function summaryFromRunIndexEntry(
    entry: RunIndexEntry,
    laneIdFallback: string,
  ): OrchestrationRunSummary {
    return {
      runId: entry.runId,
      laneId: entry.laneId || laneIdFallback,
      title: entry.title,
      goalSummary: entry.goalSummary,
      currentPhase: entry.currentPhase,
      etag: entry.etag,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      status: entry.status,
      agentCount: entry.agentCount,
      taskCount: entry.taskCount,
    };
  }

  function normalizeRunListLimit(limit: unknown): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      return RUN_LIST_DEFAULT_LIMIT;
    }
    return Math.min(RUN_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
  }

  function parseRunIndex(raw: string): RunIndex {
    const parsed = JSON.parse(raw) as Partial<RunIndex>;
    if (parsed.version !== ORCHESTRATION_INDEX_VERSION || !Array.isArray(parsed.runs)) {
      throw new Error("unsupported orchestration index");
    }
    return {
      version: ORCHESTRATION_INDEX_VERSION,
      runs: parsed.runs.filter((entry): entry is RunIndexEntry => {
        const candidate = entry as Partial<RunIndexEntry>;
        return (
          typeof candidate.runId === "string" &&
          candidate.runId.length > 0 &&
          typeof candidate.createdAt === "string" &&
          candidate.createdAt.length > 0 &&
          typeof candidate.title === "string" &&
          typeof candidate.bundlePath === "string" &&
          candidate.bundlePath.length > 0
        );
      }),
    };
  }

  async function readRunIndex(laneId: string): Promise<RunIndex | null> {
    try {
      return parseRunIndex(await fsp.readFile(indexPathForLane(laneId), "utf-8"));
    } catch {
      return null;
    }
  }

  async function appendRunIndexEntry(
    laneId: string,
    entry: RunIndexEntry,
  ): Promise<void> {
    await getLaneIndexMutex(laneId).run(async () => {
      let index = await readRunIndex(laneId);
      if (!index) {
        index = { version: ORCHESTRATION_INDEX_VERSION, runs: [] };
      }
      const withoutExisting = index.runs.filter((it) => it.runId !== entry.runId);
      const next: RunIndex = {
        version: ORCHESTRATION_INDEX_VERSION,
        runs: [...withoutExisting, entry],
      };
      await atomicWrite(indexPathForLane(laneId), JSON.stringify(next, null, 2));
    });
  }

  async function readRunIndexEntriesOrScan(laneId: string): Promise<RunIndexEntry[]> {
    const index = await getLaneIndexMutex(laneId).run(() => readRunIndex(laneId));
    if (!index) return mergeScannedIntoRunIndex(laneId, await scanRunIndexEntries(laneId));

    // Filter out stale entries whose manifest file has been deleted
    const entries: RunIndexEntry[] = [];
    let changed = false;
    for (const entry of index.runs) {
      if (!existsSync(path.join(entry.bundlePath, MANIFEST_FILE))) {
        changed = true;
        continue;
      }
      entries.push(entry);
    }
    if (changed) {
      await getLaneIndexMutex(laneId).run(async () => {
        await atomicWrite(
          indexPathForLane(laneId),
          JSON.stringify({ version: ORCHESTRATION_INDEX_VERSION, runs: entries } satisfies RunIndex, null, 2),
        );
      });
    }
    // Scan for manifests that exist on disk but are missing from the index,
    // then merge them in to self-heal the index after partial writes or
    // external modifications.
    const scanned = await scanRunIndexEntries(laneId);
    if (scanned.length > entries.length) {
      return mergeScannedIntoRunIndex(laneId, scanned);
    }
    return entries;
  }

  async function mergeScannedIntoRunIndex(
    laneId: string,
    scanned: readonly RunIndexEntry[],
  ): Promise<RunIndexEntry[]> {
    return getLaneIndexMutex(laneId).run(async () => {
      const latest = await readRunIndex(laneId);
      const latestEntries = latest?.runs ?? [];
      const next = mergeRunIndexEntries(latestEntries, scanned);
      if (!latest || next.length !== latestEntries.length) {
        await atomicWrite(
          indexPathForLane(laneId),
          JSON.stringify({ version: ORCHESTRATION_INDEX_VERSION, runs: next } satisfies RunIndex, null, 2),
        );
      }
      return next;
    });
  }

  function mergeRunIndexEntries(
    primary: readonly RunIndexEntry[],
    secondary: readonly RunIndexEntry[],
  ): RunIndexEntry[] {
    const byRunId = new Map<string, RunIndexEntry>();
    for (const entry of primary) byRunId.set(entry.runId, entry);
    for (const entry of secondary) {
      if (!byRunId.has(entry.runId)) byRunId.set(entry.runId, entry);
    }
    return Array.from(byRunId.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async function scanRunIndexEntries(laneId: string): Promise<RunIndexEntry[]> {
    const orchestrationDir = orchestrationDirForLane(laneId);
    let entries: string[];
    try {
      entries = await fsp.readdir(orchestrationDir);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") return [];
      throw err;
    }
    const out: RunIndexEntry[] = [];
    for (const runId of entries) {
      const bundlePath = path.join(orchestrationDir, runId);
      const manifestPath = path.join(bundlePath, MANIFEST_FILE);
      try {
        const stat = await fsp.stat(bundlePath);
        if (!stat.isDirectory()) continue;
        const manifest = JSON.parse(
          await fsp.readFile(manifestPath, "utf-8"),
        ) as OrchestrationManifest;
        if (
          manifest.version !== ORCHESTRATION_MANIFEST_VERSION ||
          manifest.runId !== runId ||
          manifest.laneId !== laneId
        ) {
          continue;
        }
        out.push(runIndexEntryFromManifest({
          ...manifest,
          bundlePath: manifest.bundlePath || bundlePath,
        }));
      } catch {
        // Ignore stale or malformed bundles while discovering runs.
      }
    }
    return out;
  }

  function makeEtag(runtime: RunRuntime, serverGen: number): string {
    const random = crypto.randomBytes(4).toString("hex");
    return `g${serverGen}-${random}`;
  }

  function summarizePatch(patches: readonly ManifestPatchOp[]): string {
    const counts = new Map<string, number>();
    for (const op of patches) {
      const key = op.path.split("/").slice(0, 4).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, n]) => `${key}×${n}`)
      .join(",");
  }

  function relocateRuntimeBundlePath(runtime: RunRuntime, bundlePath: string): void {
    if (runtime.bundlePath === bundlePath) return;
    if (runtime.watcher) {
      void runtime.watcher.close().catch(() => undefined);
      runtime.watcher = null;
    }
    clearWatcherDebounceTimers(runtime);
    if (runtime.watcherIdleTimer) {
      clearTimeout(runtime.watcherIdleTimer);
      runtime.watcherIdleTimer = null;
    }
    runtime.bundlePath = bundlePath;
    runtime.manifest = null;
    runtime.planMd = null;
    runtime.recentSelfWriteUntil = 0;
    runtime.suspended = false;
  }

  function getOrCreateRuntime(
    runId: string,
    bundlePath: string,
  ): RunRuntime {
    let runtime = runs.get(runId);
    if (!runtime) {
      runtime = {
        runId,
        bundlePath,
        manifest: null,
        planMd: null,
        mutex: new AsyncMutex(),
        watcher: null,
        refCount: 0,
        recentSelfWriteUntil: 0,
        watcherDebounceTimers: {},
        watcherIdleTimer: null,
        suspended: false,
      };
      runs.set(runId, runtime);
      return runtime;
    }
    return runtime;
  }

  async function loadIntoRuntime(runtime: RunRuntime): Promise<void> {
    if (runtime.manifest && runtime.planMd != null) return;
    const manifestPath = path.join(runtime.bundlePath, MANIFEST_FILE);
    const planPath = path.join(runtime.bundlePath, PLAN_FILE);
    try {
      const manifestRaw = await fsp.readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestRaw) as OrchestrationManifest;
      if (manifest.version !== ORCHESTRATION_MANIFEST_VERSION) {
        throw new Error(
          `unsupported manifest version ${manifest.version} (expected ${ORCHESTRATION_MANIFEST_VERSION})`,
        );
      }
      if (manifest.runId !== runtime.runId) {
        runtime.suspended = true;
        runtime.manifest = null;
        runtime.planMd = null;
        return;
      }
      runtime.manifest = applyHeartbeatLiveness(
        normalizeManifestShape(manifest),
        await readHeartbeatLiveness(runtime.bundlePath),
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") {
        runtime.manifest = null;
      } else {
        throw err;
      }
    }
    try {
      runtime.planMd = await fsp.readFile(planPath, "utf-8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e && e.code === "ENOENT") {
        runtime.planMd = "";
      } else {
        throw err;
      }
    }
  }

  async function hydrateRunForList(entry: RunIndexEntry): Promise<void> {
    const runtime = getOrCreateRuntime(entry.runId, entry.bundlePath);
    await runtime.mutex.run(async () => {
      try {
        await loadIntoRuntime(runtime);
        if (!runtime.manifest) {
          runs.delete(entry.runId);
          return;
        }
      } catch {
        runs.delete(entry.runId);
      }
    });
  }

  function emit(payload: OrchestrationEventPayload): void {
    emitter.emit("event", payload);
  }

  function markSelfWrite(runtime: RunRuntime): void {
    runtime.recentSelfWriteUntil = Date.now() + SELF_WRITE_WINDOW_MS;
  }

  function clearWatcherDebounceTimers(runtime: RunRuntime): void {
    for (const timer of Object.values(runtime.watcherDebounceTimers)) {
      if (timer) clearTimeout(timer);
    }
    runtime.watcherDebounceTimers = {};
  }

  async function startWatcher(runtime: RunRuntime): Promise<void> {
    if (runtime.watcherIdleTimer) {
      clearTimeout(runtime.watcherIdleTimer);
      runtime.watcherIdleTimer = null;
    }
    if (runtime.watcher) return;
    if (!existsSync(runtime.bundlePath)) return;
    const watcher = chokidar.watch(
      [
        path.join(runtime.bundlePath, MANIFEST_FILE),
        path.join(runtime.bundlePath, PLAN_FILE),
      ],
      {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 25, pollInterval: 10 },
      },
    );
    runtime.watcher = watcher;
    const debouncedReload = (kind: WatcherFileKind): void => {
      const existingTimer = runtime.watcherDebounceTimers[kind];
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      runtime.watcherDebounceTimers[kind] = setTimeout(() => {
        delete runtime.watcherDebounceTimers[kind];
        void runtime.mutex.run(async () => {
          if (Date.now() < runtime.recentSelfWriteUntil) {
            return; // suppress self-emitted events
          }
          await handleExternalChange(runtime, kind);
        });
      }, WATCHER_DEBOUNCE_MS);
    };
    watcher.on("change", (full) => {
      const base = path.basename(full);
      if (base === MANIFEST_FILE) debouncedReload("manifest");
      else if (base === PLAN_FILE) debouncedReload("plan");
    });
    watcher.on("unlink", (full) => {
      const base = path.basename(full);
      if (base === MANIFEST_FILE) {
        runtime.suspended = true;
        runtime.manifest = null;
        emit({
          runId: runtime.runId,
          kind: "lifecycle",
          etag: "",
          status: "suspended",
        });
      }
    });
    watcher.on("error", () => {
      /* non-fatal */
    });
  }

  async function handleExternalChange(
    runtime: RunRuntime,
    kind: "manifest" | "plan",
  ): Promise<void> {
    try {
      const manifestPath = path.join(runtime.bundlePath, MANIFEST_FILE);
      const planPath = path.join(runtime.bundlePath, PLAN_FILE);
      if (kind === "manifest") {
        const raw = await fsp.readFile(manifestPath, "utf-8");
        const next = applyHeartbeatLiveness(
          normalizeManifestShape(JSON.parse(raw) as OrchestrationManifest),
          await readHeartbeatLiveness(runtime.bundlePath),
        );
        // Resilience: if runId mismatches (e.g. branch checkout swapped the
        // file), do not blindly etag-bump; mark suspended and ignore.
        if (next.runId !== runtime.runId) {
          runtime.suspended = true;
          runtime.manifest = null;
          runtime.planMd = null;
          emit({
            runId: runtime.runId,
            kind: "lifecycle",
            etag: next.etag ?? "",
            status: "suspended",
          });
          return;
        }
        runtime.manifest = next;
        if (runtime.suspended) {
          runtime.suspended = false;
          emit({
            runId: runtime.runId,
            kind: "lifecycle",
            etag: next.etag,
            status: "resumed",
          });
        }
        emit({
          runId: runtime.runId,
          kind: "manifest",
          etag: next.etag,
          manifest: next,
        });
      } else {
        const raw = await fsp.readFile(planPath, "utf-8");
        runtime.planMd = raw;
        emit({
          runId: runtime.runId,
          kind: "plan",
          etag: runtime.manifest?.etag ?? "",
          planMd: raw,
        });
      }
    } catch {
      // ignore; watcher will re-fire
    }
  }

  async function persistManifest(
    runtime: RunRuntime,
    manifest: OrchestrationManifest,
  ): Promise<void> {
    const bundlePath = runtime.bundlePath;
    const manifestPath = path.join(bundlePath, MANIFEST_FILE);
    manifest.bundlePath = bundlePath;
    const expectedBaseGeneration =
      runtime.manifest?.serverGeneration ?? manifest.serverGeneration - 1;
    const expectedBaseEtag = runtime.manifest?.etag;
    const rejectIfDiskAdvanced = async (): Promise<void> => {
      try {
        const raw = await fsp.readFile(manifestPath, "utf-8");
        const onDisk = normalizeManifestShape(JSON.parse(raw) as OrchestrationManifest);
        if (onDisk.runId !== runtime.runId) {
          runtime.suspended = true;
          runtime.manifest = null;
          runtime.planMd = null;
          throw new OrchestrationRunSuspendedError();
        }
        if (
          onDisk.runId === runtime.runId &&
          onDisk.serverGeneration > expectedBaseGeneration &&
          onDisk.etag !== expectedBaseEtag
        ) {
          runtime.manifest = onDisk;
          throw new OrchestrationPersistConflictError(onDisk);
        }
      } catch (err) {
        if (
          err instanceof OrchestrationPersistConflictError
          || err instanceof OrchestrationRunSuspendedError
        ) {
          throw err;
        }
        const e = err as NodeJS.ErrnoException;
        if (e?.code !== "ENOENT") {
          throw err;
        }
      }
    };
    await rejectIfDiskAdvanced();
    markSelfWrite(runtime);
    try {
      await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2), {
        beforeCommit: rejectIfDiskAdvanced,
      });
    } catch (err) {
      runtime.recentSelfWriteUntil = 0;
      throw err;
    }
    await writeServerGeneration(bundlePath, manifest.serverGeneration);
    runtime.manifest = manifest;
    await appendRunIndexEntry(
      manifest.laneId,
      runIndexEntryFromManifest(manifest, runtime.suspended ? "suspended" : "active"),
    );
  }

  async function persistPlan(runtime: RunRuntime, plan: string): Promise<void> {
    const planPath = path.join(runtime.bundlePath, PLAN_FILE);
    markSelfWrite(runtime);
    await atomicWrite(planPath, plan);
    runtime.planMd = plan;
  }

  function assertRunWritable(runtime: RunRuntime): void {
    if (runtime.suspended) {
      throw new OrchestrationRunSuspendedError();
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async function runCreate(
    req: OrchestrationRunCreateRequest,
  ): Promise<OrchestrationRunCreateResponse> {
    const runId = newRunId();
    const bundlePath = path.join(req.bundleRoot, ".ade", "orchestration", runId);
    await ensureBundleDir(bundlePath);
    const runtime = getOrCreateRuntime(runId, bundlePath);
    return runtime.mutex.run(async () => {
      const serverGeneration = (await readServerGeneration(bundlePath)) + 1;
      const etag = makeEtag(runtime, serverGeneration);
      const createdAt = nowIso();
      const manifest: OrchestrationManifest = {
        version: ORCHESTRATION_MANIFEST_VERSION,
        schemaCompatibility: { minReader: 1, maxKnown: 1 },
        runId,
        laneId: req.laneId,
        bundlePath,
        etag,
        serverGeneration,
        createdAt,
        updatedAt: createdAt,
        title: req.title?.trim() || "Orchestration run",
        goalSummary: req.goalSummary?.trim() || "",
        currentPhase: "planning",
        phases: [
          { id: "planning", title: "Planning", status: "active", startedAt: createdAt },
          { id: "developing", title: "Developing", status: "pending" },
          { id: "validating", title: "Validating", status: "pending" },
          { id: "wrapup", title: "Wrap-up", status: "pending" },
        ],
        agents: [
          {
            sessionId: req.leadSessionId,
            role: "lead",
            goalSummary: req.goalSummary?.trim() || "Plan the run",
            status: "running",
            spawnedAt: createdAt,
          },
        ],
        tasks: [],
        validationStrategy: { steps: [], checklist: [] },
        modelRouting: {},
        assets: [],
        decisions: [],
        userOverrides: [],
        leadState: {
          lastSnapshotEtag: etag,
          lastSnapshotSeenAt: createdAt,
          planning: createInitialPlanningState(),
        },
        planSpec: createInitialPlanSpec(),
        history: [
          { etag, at: createdAt, summary: "run created", patchKindSummary: "init" },
        ],
      };
      await persistManifest(runtime, manifest);
      await persistPlan(runtime, initialPlanMd(manifest));
      emit({
        runId,
        kind: "manifest",
        etag,
        manifest,
      });
      return { runId, manifest, etag };
    });
  }

  async function bundleRead(
    runId: string,
    bundlePath: string,
  ): Promise<OrchestrationBundleReadResponse> {
    const runtime = getOrCreateRuntime(runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (!runtime.manifest) {
        throw new Error(`run ${runId} not found at ${bundlePath}`);
      }
      return {
        manifest: runtime.manifest,
        planMd: runtime.planMd ?? "",
        etag: runtime.manifest.etag,
      };
    });
  }

  async function manifestReadSection(
    runId: string,
    bundlePath: string,
    section: ManifestSection,
  ): Promise<OrchestrationManifestSectionReadResponse> {
    const runtime = getOrCreateRuntime(runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (!runtime.manifest) throw new Error(`run ${runId} not found`);
      const data = runtime.manifest[section];
      return { section, data, etag: runtime.manifest.etag };
    });
  }

  async function manifestPatch(
    req: OrchestrationManifestPatchRequest,
    bundlePath: string,
  ): Promise<OrchestrationManifestPatchResponse> {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (runtime.suspended) {
        return {
          ok: false,
          error: "validation_failed",
          message: RUN_SUSPENDED_MESSAGE,
        };
      }
      const current = runtime.manifest;
      if (!current) {
        return {
          ok: false,
          error: "validation_failed",
          message: `run ${req.runId} not found`,
        };
      }
      if (current.etag !== req.ifMatchEtag) {
        return {
          ok: false,
          error: "etag_conflict",
          manifest: current,
          etag: current.etag,
        };
      }
      if (!req.patches.length) {
        return { ok: true, manifest: current, etag: current.etag };
      }
      const role: OrchestrationRole = req.actorRole ?? "lead";

      // Per-op policy check
      for (const op of req.patches) {
        const policy = checkPatchOp(op, {
          actorRole: role,
          actorSessionId: req.actorSessionId,
          manifest: current,
        });
        if (!policy.allowed) {
          return {
            ok: false,
            error: "policy_denied",
            message: `${policy.reason} (path: ${policy.path})`,
            manifest: current,
            etag: current.etag,
          };
        }
      }

      // Coordinated-transaction enforcement: status="done" against a task with
      // required validation gate is rejected unless its checklist items have
      // all passed OR (humanOverride + matching UserOverrideEntry) ship in the
      // same transaction.
      const hasHumanOverride = req.patches.some(isTaskHumanOverridePatch);
      const hasUserOverrideEntry = req.patches.some(isUserOverrideEntryAppend);
      for (const op of req.patches) {
        if (isTaskStatusDonePatch(op)) {
          const taskId = extractTaskIdFromPath(op.path);
          if (!taskId) continue;
          const task = current.tasks.find((t) => t.id === taskId);
          if (!task) continue;
          if (!task.validationGate.required) continue;
          const checklistOk = taskValidationGatesSatisfied(current, taskId);
          if (!checklistOk && !(hasHumanOverride && hasUserOverrideEntry)) {
            return {
              ok: false,
              error: "validation_failed",
              message: `task ${taskId} cannot be marked done: required validation gates not satisfied (override requires humanOverride + UserOverrideEntry in same patch)`,
              manifest: current,
              etag: current.etag,
            };
          }
        }
        // Lead lowering required=false also requires the override pair.
        if (isValidationGateRequiredOff(op) && !(hasHumanOverride && hasUserOverrideEntry)) {
          return {
            ok: false,
            error: "policy_denied",
            message: "lowering validationGate.required requires humanOverride + UserOverrideEntry in same patch",
            manifest: current,
            etag: current.etag,
          };
        }
      }

      const next = normalizeManifestShape(applyPatches(current, req.patches));
      const shapeError = validateManifestShape(next);
      if (shapeError) {
        return {
          ok: false,
          error: "validation_failed",
          message: shapeError,
          manifest: current,
          etag: current.etag,
        };
      }
      const updatedAt = nowIso();
      const serverGeneration = current.serverGeneration + 1;
      const etag = makeEtag(runtime, serverGeneration);
      next.updatedAt = updatedAt;
      next.serverGeneration = serverGeneration;
      next.etag = etag;
      const summary = req.summary ?? summarizePatch(req.patches);
      const ring = [
        ...current.history.slice(-HISTORY_RING_LIMIT + 1),
        { etag, at: updatedAt, summary: "patch", patchKindSummary: summary },
      ];
      next.history = ring;

      try {
        await persistManifest(runtime, next);
      } catch (err) {
        if (err instanceof OrchestrationRunSuspendedError) {
          return {
            ok: false,
            error: "validation_failed",
            message: RUN_SUSPENDED_MESSAGE,
          };
        }
        if (err instanceof OrchestrationPersistConflictError) {
          const latest = runtime.manifest ?? err.onDisk;
          return {
            ok: false,
            error: "etag_conflict",
            manifest: latest,
            etag: latest.etag,
          };
        }
        throw err;
      }
      emit({
        runId: req.runId,
        kind: "manifest",
        etag,
        manifest: next,
        patch: req.patches,
      });
      return { ok: true, manifest: next, etag };
    });
  }

  async function planAppend(
    req: OrchestrationPlanAppendRequest,
    bundlePath: string,
  ): Promise<{ planMd: string; etag: string }> {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      assertRunWritable(runtime);
      if (!runtime.manifest) throw new Error(`run ${req.runId} not found`);
      const prev = runtime.planMd ?? "";
      const heading = req.section.startsWith("#")
        ? req.section
        : `## ${req.section}`;
      const stamp = nowIso();
      const pin = req.pinId ? ` <a id="${escapeId(req.pinId)}"></a>` : "";
      const next = `${prev}${prev.endsWith("\n") || !prev ? "" : "\n"}\n${heading}${pin}\n<sub>${stamp}</sub>\n\n${req.body.trim()}\n`;
      await persistPlan(runtime, next);
      emit({
        runId: req.runId,
        kind: "plan",
        etag: runtime.manifest.etag,
        planMd: next,
        planPatch: { from: prev, to: next },
      });
      return { planMd: next, etag: runtime.manifest.etag };
    });
  }

  async function planWrite(
    req: OrchestrationPlanWriteRequest,
    bundlePath: string,
  ): Promise<{ planMd: string; etag: string } | { error: "etag_conflict"; etag: string }> {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      assertRunWritable(runtime);
      if (!runtime.manifest) throw new Error(`run ${req.runId} not found`);
      if (runtime.manifest.etag !== req.ifMatchEtag) {
        return { error: "etag_conflict", etag: runtime.manifest.etag };
      }
      const prev = runtime.planMd ?? "";
      await persistPlan(runtime, req.nextPlanMd);
      emit({
        runId: req.runId,
        kind: "plan",
        etag: runtime.manifest.etag,
        planMd: req.nextPlanMd,
        planPatch: { from: prev, to: req.nextPlanMd },
      });
      return { planMd: req.nextPlanMd, etag: runtime.manifest.etag };
    });
  }

  async function assetRegister(
    req: OrchestrationAssetRegisterRequest,
    bundlePath: string,
  ): Promise<{ asset: OrchestrationAsset; etag: string }> {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      assertRunWritable(runtime);
      if (!runtime.manifest) throw new Error(`run ${req.runId} not found`);
      const id = `A-${runtime.manifest.assets.length + 1}-${shortRand()}`;
      const asset: OrchestrationAsset = {
        id,
        path: req.relPath,
        kind: req.kind,
        version: req.version ?? 1,
        approval: req.approval ?? "pending",
      };
      const op: ManifestPatchOp = {
        op: "add",
        path: "/assets/-",
        value: asset,
      };
      const patchRes = await directPatch(runtime, [op], "asset-register");
      emit({
        runId: req.runId,
        kind: "asset",
        etag: patchRes.etag,
        asset,
      });
      return { asset, etag: patchRes.etag };
    });
  }

  async function claimTask(
    req: OrchestrationClaimTaskRequest,
    bundlePath: string,
  ): Promise<
    | { ok: true; manifest: OrchestrationManifest; etag: string }
    | { ok: false; reason: string; manifest: OrchestrationManifest; etag: string }
  > {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      assertRunWritable(runtime);
      if (!runtime.manifest) {
        throw new Error(`run ${req.runId} not found`);
      }
      const manifest = runtime.manifest;
      const registeredAgent = manifest.agents.find(
        (agent) => agent.sessionId === req.sessionId,
      );
      if (!registeredAgent) {
        return {
          ok: false,
          reason: "session not registered as agent",
          manifest,
          etag: manifest.etag,
        };
      }
      const task = manifest.tasks.find((t) => t.id === req.taskId);
      if (!task) {
        return {
          ok: false,
          reason: `task ${req.taskId} not found`,
          manifest,
          etag: manifest.etag,
        };
      }
      if (task.status === "done" || task.status === "failed") {
        return {
          ok: false,
          reason: `task ${req.taskId} is terminal (${task.status}) and cannot be claimed`,
          manifest,
          etag: manifest.etag,
        };
      }
      const stillClaimed =
        task.claimLeaseUntil && new Date(task.claimLeaseUntil).getTime() > Date.now();
      if (
        task.assigneeSessionId &&
        task.assigneeSessionId !== req.sessionId &&
        stillClaimed
      ) {
        return {
          ok: false,
          reason: `task ${req.taskId} already claimed by ${task.assigneeSessionId}`,
          manifest,
          etag: manifest.etag,
        };
      }
      const claimedAt = nowIso();
      const leaseUntil = new Date(Date.now() + req.leaseMs).toISOString();
      const actor = manifest.agents.find((agent) => agent.sessionId === req.sessionId);
      const ops: ManifestPatchOp[] = [
        {
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/status`,
          value: "claimed" as OrchestrationTaskStatus,
        },
        {
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/assigneeSessionId`,
          value: req.sessionId,
        },
        {
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/claimedAt`,
          value: claimedAt,
        },
        {
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/claimLeaseUntil`,
          value: leaseUntil,
        },
      ];
      if (actor) {
        ops.push({
          op: "replace",
          path: `/agents/{sessionId:${req.sessionId}}/status`,
          value: "running" as const,
        });
      }
      const patchRes = await directPatch(runtime, ops, "claim");
      return { ok: true, manifest: patchRes.manifest, etag: patchRes.etag };
    });
  }

  async function releaseTask(
    req: OrchestrationReleaseTaskRequest,
    bundlePath: string,
  ): Promise<{ manifest: OrchestrationManifest; etag: string }> {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      assertRunWritable(runtime);
      const manifest = runtime.manifest;
      if (!manifest) throw new Error(`run ${req.runId} not found`);
      const task = manifest.tasks.find((entry) => entry.id === req.taskId);
      if (!task) throw new Error(`task ${req.taskId} not found`);
      const actor = manifest.agents.find((agent) => agent.sessionId === req.sessionId);
      if (!actor) throw new Error(`agent ${req.sessionId} not registered in run ${req.runId}`);
      if (
        actor.role !== "lead"
        && task.assigneeSessionId
        && task.assigneeSessionId !== req.sessionId
      ) {
        throw new Error(`task ${req.taskId} is assigned to ${task.assigneeSessionId}, not ${req.sessionId}`);
      }
      if (
        req.status === "done"
        && task.validationGate.required
        && !taskValidationGatesSatisfied(manifest, req.taskId)
      ) {
        throw new Error(
          `task ${req.taskId} cannot be marked done: required validation gates not satisfied`,
        );
      }
      const ops: ManifestPatchOp[] = [
        {
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/status`,
          value: req.status,
        },
        {
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/claimLeaseUntil`,
          value: null,
        },
      ];
      const inferredSupersededTaskIds = inferValidationRerunSupersedes(
        manifest,
        task,
        req.status,
      );
      if (inferredSupersededTaskIds.length) {
        ops.push({
          op: "replace",
          path: `/tasks/{id:${req.taskId}}/supersedes`,
          value: mergeSupersedes(taskSupersedesIds(task), inferredSupersededTaskIds),
        });
      }
      if (actor.role !== "lead") {
        let agentStatus: string;
        if (req.status === "done") agentStatus = "completed";
        else if (req.status === "failed") agentStatus = "failed";
        else agentStatus = "blocked";
        ops.push({
          op: "replace",
          path: `/agents/{sessionId:${req.sessionId}}/status`,
          value: agentStatus,
        });
      }
      const projectedManifest = applyPatches(manifest, ops);
      ops.push(
        ...buildPhaseTransitionOpsAfterTaskRelease(
          projectedManifest,
          req.taskId,
          req.status,
          nowIso(),
        ),
      );
      const patchRes = await directPatch(runtime, ops, "release");
      return { manifest: patchRes.manifest, etag: patchRes.etag };
    });
  }

  function validatorMayRecordValidationRun(
    manifest: OrchestrationManifest,
    actor: OrchestrationManifest["agents"][number],
    task: OrchestrationManifest["tasks"][number],
    stepId: string,
  ): boolean {
    if (actor.role !== "validator") return false;
    if (task.assigneeSessionId === actor.sessionId && task.phaseId === "validating") {
      return true;
    }
    const currentStepId = actor.currentStepId?.trim();
    if (!currentStepId) return false;
    const assignedTask = manifest.tasks.find((entry) => entry.id === currentStepId);
    return assignedTask?.assigneeSessionId === actor.sessionId
      && assignedTask.phaseId === "validating"
      && assignedTask.validationGate.stepIds.includes(stepId);
  }

  async function recordValidationRun(
    req: OrchestrationRecordValidationRunRequest,
    bundlePath: string,
  ): Promise<
    | { ok: true; manifest: OrchestrationManifest; etag: string; checklistItemId: string; runId: string }
    | { ok: false; error: "not_found" | "policy_denied" | "validation_failed"; message: string; manifest?: OrchestrationManifest; etag?: string }
  > {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (runtime.suspended) {
        return {
          ok: false,
          error: "validation_failed",
          message: RUN_SUSPENDED_MESSAGE,
        };
      }
      const manifest = runtime.manifest;
      if (!manifest) {
        return {
          ok: false,
          error: "not_found",
          message: `run ${req.runId} not found`,
        };
      }
      const actor = manifest.agents.find((agent) => agent.sessionId === req.sessionId);
      if (!actor) {
        return {
          ok: false,
          error: "not_found",
          message: `agent ${req.sessionId} not registered in run ${req.runId}`,
          manifest,
          etag: manifest.etag,
        };
      }
      const task = manifest.tasks.find((entry) => entry.id === req.taskId);
      if (!task) {
        return {
          ok: false,
          error: "not_found",
          message: `task ${req.taskId} not found`,
          manifest,
          etag: manifest.etag,
        };
      }
      const step = manifest.validationStrategy.steps.find((entry) => entry.id === req.stepId);
      if (!step) {
        return {
          ok: false,
          error: "not_found",
          message: `validation step ${req.stepId} not found`,
          manifest,
          etag: manifest.etag,
        };
      }
      if (!task.validationGate.stepIds.includes(req.stepId)) {
        return {
          ok: false,
          error: "validation_failed",
          message: `validation step ${req.stepId} is not required by task ${req.taskId}`,
          manifest,
          etag: manifest.etag,
        };
      }
      if (step.appliesToTaskIds?.length && !step.appliesToTaskIds.includes(req.taskId)) {
        return {
          ok: false,
          error: "validation_failed",
          message: `validation step ${req.stepId} does not apply to task ${req.taskId}`,
          manifest,
          etag: manifest.etag,
        };
      }
      if (
        actor.role === "worker" &&
        (task.assigneeSessionId !== req.sessionId || step.scope !== "per_worker")
      ) {
        return {
          ok: false,
          error: "policy_denied",
          message: "workers may only record validation runs for their own per-worker gates",
          manifest,
          etag: manifest.etag,
        };
      }
      if (
        actor.role === "validator" &&
        !validatorMayRecordValidationRun(manifest, actor, task, req.stepId)
      ) {
        return {
          ok: false,
          error: "policy_denied",
          message: "validators may only record assigned validation gates",
          manifest,
          etag: manifest.etag,
        };
      }
      if (actor.role !== "lead" && actor.role !== "worker" && actor.role !== "validator") {
        return {
          ok: false,
          error: "policy_denied",
          message: `actor role ${actor.role} cannot record validation runs`,
          manifest,
          etag: manifest.etag,
        };
      }

      const startedAt = req.startedAt?.trim() || nowIso();
      const runId = `run-${escapeId(req.taskId)}-${escapeId(req.stepId)}-${shortRand()}`;
      const findings: ValidationFinding[] = (req.findings ?? [])
        .filter((f) => f && typeof f.title === "string" && f.title.trim())
        .map((f, index) => ({
          id: f.id?.trim() || `F-${escapeId(req.taskId)}-${escapeId(req.stepId)}-${index + 1}-${shortRand()}`,
          severity: f.severity,
          title: f.title.trim(),
          ...(f.locus?.trim() ? { locus: f.locus.trim() } : {}),
          ...(f.detail?.trim() ? { detail: f.detail.trim() } : {}),
          ...(f.fix?.trim() ? { fix: f.fix.trim() } : {}),
          ...(typeof f.behaviorPreserving === "boolean" ? { behaviorPreserving: f.behaviorPreserving } : {}),
          ...(f.regressionTestTarget?.trim() ? { regressionTestTarget: f.regressionTestTarget.trim() } : {}),
        }));
      if (
        req.status === "passed" &&
        findings.some((finding) => finding.severity === "blocker" || finding.severity === "high")
      ) {
        return {
          ok: false,
          error: "validation_failed",
          message: "passed validation runs cannot include blocker or high severity findings",
          manifest,
          etag: manifest.etag,
        };
      }
      const run = {
        id: runId,
        runBySessionId: req.sessionId,
        status: req.status,
        startedAt,
        ...(req.status !== "running" ? { endedAt: req.endedAt?.trim() || startedAt } : {}),
        ...(req.notes?.trim() ? { notes: req.notes.trim() } : {}),
        ...(req.attachedEvidence?.length ? { attachedEvidence: req.attachedEvidence } : {}),
        ...(findings.length ? { findings } : {}),
      };
      const existing = manifest.validationStrategy.checklist.find(
        (entry) => entry.taskId === req.taskId && entry.stepId === req.stepId,
      );
      const itemId = existing?.id ?? `C-${escapeId(req.taskId)}-${escapeId(req.stepId)}`;
      const patches: ManifestPatchOp[] = existing
        ? [
            {
              op: "add",
              path: `/validationStrategy/checklist/{id:${itemId}}/runs/-`,
              value: run,
            },
            {
              op: "replace",
              path: `/validationStrategy/checklist/{id:${itemId}}/latestRunId`,
              value: runId,
            },
          ]
        : [
            {
              op: "add",
              path: "/validationStrategy/checklist/-",
              value: {
                id: itemId,
                stepId: req.stepId,
                taskId: req.taskId,
                runs: [run],
                latestRunId: runId,
              },
            },
          ];
      let patchRes: { manifest: OrchestrationManifest; etag: string };
      try {
        patchRes = await directPatch(
          runtime,
          patches,
          `record validation ${req.taskId}/${req.stepId} ${req.status}`,
        );
      } catch (err) {
        if (err instanceof OrchestrationRunSuspendedError) {
          return {
            ok: false,
            error: "validation_failed",
            message: RUN_SUSPENDED_MESSAGE,
          };
        }
        throw err;
      }
      return {
        ok: true,
        manifest: patchRes.manifest,
        etag: patchRes.etag,
        checklistItemId: itemId,
        runId,
      };
    });
  }

  async function agentHeartbeat(
    req: { runId: string; sessionId: string },
    bundlePath: string,
  ): Promise<{ ok: true; etag: string } | { ok: false; reason: string; etag?: string }> {
    const runtime = getOrCreateRuntime(req.runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (runtime.suspended) {
        return { ok: false, reason: RUN_SUSPENDED_MESSAGE };
      }
      const manifest = runtime.manifest;
      if (!manifest) return { ok: false, reason: `run ${req.runId} not found` };
      if (!manifest.agents.some((agent) => agent.sessionId === req.sessionId)) {
        return { ok: false, reason: `agent ${req.sessionId} not found`, etag: manifest.etag };
      }
      const next = structuredClone(manifest) as OrchestrationManifest;
      const agent = next.agents.find((entry) => entry.sessionId === req.sessionId);
      const lastHeartbeatAt = nowIso();
      if (agent) agent.lastHeartbeatAt = lastHeartbeatAt;
      runtime.manifest = next;
      const heartbeats = await readHeartbeatLiveness(runtime.bundlePath);
      heartbeats[req.sessionId] = lastHeartbeatAt;
      // Heartbeats are liveness metadata. Keep them out of manifest.json/.gen so
      // they do not rewrite the optimistic-concurrency document or re-emit the
      // same etag as a manifest mutation.
      try {
        await writeHeartbeatLiveness(runtime.bundlePath, heartbeats);
      } catch (err) {
        throw err;
      }
      emit({
        runId: req.runId,
        kind: "heartbeat",
        etag: next.etag,
        sessionId: req.sessionId,
        lastHeartbeatAt,
      });
      return { ok: true, etag: next.etag };
    });
  }

  async function runList(
    laneId?: string,
    options: { limit?: number } = {},
  ): Promise<OrchestrationRunSummary[]> {
    const limit = normalizeRunListLimit(options.limit);
    if (laneId) {
      const entries = await readRunIndexEntriesOrScan(laneId);
      return entries.slice(-limit).map((entry) => summaryFromRunIndexEntry(entry, laneId));
    }
    const out: OrchestrationRunSummary[] = [];
    for (const runtime of runs.values()) {
      const m = runtime.manifest;
      if (!m) continue;
      if (laneId && m.laneId !== laneId) continue;
      out.push({
        runId: m.runId,
        laneId: m.laneId,
        title: m.title,
        goalSummary: m.goalSummary,
        currentPhase: m.currentPhase,
        etag: m.etag,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        status: runtime.suspended ? "suspended" : "active",
        agentCount: m.agents.length,
        taskCount: m.tasks.length,
      });
    }
    return out
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit);
  }

  /** Release a subscriber's reference; closes watcher when refCount hits zero. */
  async function release(runId: string): Promise<void> {
    const runtime = runs.get(runId);
    if (!runtime) return;
    runtime.refCount = Math.max(0, runtime.refCount - 1);
    if (runtime.refCount === 0) {
      clearWatcherDebounceTimers(runtime);
      if (runtime.watcher) {
        if (runtime.watcherIdleTimer) clearTimeout(runtime.watcherIdleTimer);
        runtime.watcherIdleTimer = setTimeout(() => {
          runtime.watcherIdleTimer = null;
          if (runtime.refCount > 0 || !runtime.watcher) return;
          void runtime.watcher.close().catch(() => undefined);
          runtime.watcher = null;
          if (runtime.refCount === 0) {
            runs.delete(runId);
          }
        }, WATCHER_IDLE_CLOSE_MS);
        runtime.watcherIdleTimer.unref?.();
      } else {
        runs.delete(runId);
      }
    }
  }

  async function dispose(): Promise<void> {
    for (const runtime of runs.values()) {
      if (runtime.watcher) await runtime.watcher.close();
      clearWatcherDebounceTimers(runtime);
      if (runtime.watcherIdleTimer) clearTimeout(runtime.watcherIdleTimer);
    }
    runs.clear();
  }

  async function subscribe(runId: string, bundlePath: string): Promise<void> {
    const runtime = getOrCreateRuntime(runId, bundlePath);
    await runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (!runtime.manifest) {
        throw new Error(`run ${runId} not found at ${bundlePath}`);
      }
      await startWatcher(runtime);
      runtime.refCount++;
    });
  }

  function on(
    name: "event",
    cb: (payload: OrchestrationEventPayload) => void,
  ): () => void {
    emitter.on(name, cb);
    return () => emitter.off(name, cb);
  }

  function getManifestForRun(runId: string): OrchestrationManifest | null {
    const runtime = runs.get(runId);
    return runtime?.manifest ?? null;
  }

  function getBundlePathForRun(runId: string): string | null {
    const runtime = runs.get(runId);
    return runtime?.bundlePath ?? null;
  }

  // Internal direct patch — bypasses ifMatchEtag (used for service-internal
  // bumps like asset registration / claim). Still walks the policy check
  // with role=lead.
  async function directPatch(
    runtime: RunRuntime,
    patches: readonly ManifestPatchOp[],
    summary: string,
  ): Promise<{ manifest: OrchestrationManifest; etag: string }> {
    assertRunWritable(runtime);
    if (!runtime.manifest) throw new Error("manifest not loaded");
    const next = normalizeManifestShape(applyPatches(runtime.manifest, patches));
    const shapeError = validateManifestShape(next);
    if (shapeError) {
      throw new Error(shapeError);
    }
    const updatedAt = nowIso();
    const serverGeneration = runtime.manifest.serverGeneration + 1;
    const etag = makeEtag(runtime, serverGeneration);
    next.updatedAt = updatedAt;
    next.serverGeneration = serverGeneration;
    next.etag = etag;
    next.history = [
      ...runtime.manifest.history.slice(-HISTORY_RING_LIMIT + 1),
      { etag, at: updatedAt, summary, patchKindSummary: summarizePatch([...patches]) },
    ];
    await persistManifest(runtime, next);
    emit({
      runId: runtime.runId,
      kind: "manifest",
      etag,
      manifest: next,
      patch: [...patches],
    });
    return { manifest: next, etag };
  }

  /**
   * Service-level plan approval — bypasses per-op policy so the approval-gated
   * paths (/leadState/planApprovedAt, /leadState/planApprovedBySessionId,
   * /currentPhase) can only be modified through this controlled method, not via
   * raw manifestPatch from the lead.
   */
  async function approvePlan(
    runId: string,
    bundlePath: string,
    patches: readonly ManifestPatchOp[],
    summary: string,
  ): Promise<{ ok: true; manifest: OrchestrationManifest; etag: string } | { ok: false; error: string; message: string }> {
    const runtime = getOrCreateRuntime(runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (runtime.suspended) {
        return { ok: false, error: "run_suspended", message: RUN_SUSPENDED_MESSAGE };
      }
      if (!runtime.manifest) {
        return { ok: false, error: "run_not_found", message: `run ${runId} not found` };
      }
      try {
        const result = await directPatch(runtime, patches, summary);
        return { ok: true, manifest: result.manifest, etag: result.etag };
      } catch (err) {
        if (err instanceof OrchestrationRunSuspendedError) {
          return { ok: false, error: "run_suspended", message: RUN_SUSPENDED_MESSAGE };
        }
        if (err instanceof OrchestrationPersistConflictError) {
          return {
            ok: false,
            error: "etag_conflict",
            message: `manifest on disk advanced to generation ${err.onDisk.serverGeneration}`,
          };
        }
        throw err;
      }
    });
  }

  // --------------------------------------------------------------------------
  // Planning state machine (deterministic dev-loop sequence).
  //
  // Each method mutates gate-controlled state (`leadState.planning`, `planSpec`)
  // through directPatch only — the lead is denied raw access to these paths
  // (see patchPolicy), so the intake → 3 rounds → ready → approved sequence
  // cannot be skipped or forged. Mirrors /context intake + /plan deliberation.
  // --------------------------------------------------------------------------

  type PlanningMutationResult =
    | { ok: true; manifest: OrchestrationManifest; etag: string }
    | { ok: false; error: string; message: string; missing?: string[] };

  async function runPlanningMutation(
    runId: string,
    bundlePath: string,
    fn: (runtime: RunRuntime) => Promise<PlanningMutationResult>,
  ): Promise<PlanningMutationResult> {
    const runtime = getOrCreateRuntime(runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (runtime.suspended) {
        return { ok: false, error: "run_suspended", message: RUN_SUSPENDED_MESSAGE };
      }
      if (!runtime.manifest) {
        return { ok: false, error: "run_not_found", message: `run ${runId} not found` };
      }
      try {
        return await fn(runtime);
      } catch (err) {
        if (err instanceof OrchestrationRunSuspendedError) {
          return { ok: false, error: "run_suspended", message: RUN_SUSPENDED_MESSAGE };
        }
        if (err instanceof OrchestrationPersistConflictError) {
          return {
            ok: false,
            error: "etag_conflict",
            message: `manifest advanced to generation ${err.onDisk.serverGeneration}`,
          };
        }
        throw err;
      }
    });
  }

  function planningOf(
    manifest: OrchestrationManifest,
  ): NonNullable<OrchestrationManifest["leadState"]["planning"]> {
    return manifest.leadState.planning ?? createInitialPlanningState();
  }

  function dedupeStrings(values: readonly string[] | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values ?? []) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }

  async function recordPlanningIntake(
    runId: string,
    bundlePath: string,
    intake: PlanningIntakeArtifact,
  ): Promise<PlanningMutationResult> {
    return runPlanningMutation(runId, bundlePath, async (runtime) => {
      const planning = planningOf(runtime.manifest!);
      if (planning.stage !== "intake") {
        return {
          ok: false,
          error: "stage_conflict",
          message: `codebase intake already recorded (planning stage: ${planning.stage})`,
        };
      }
      const missing: string[] = [];
      if (!intake.projectShape?.trim()) missing.push("projectShape");
      if (!intake.testStack?.trim()) missing.push("testStack");
      if (!intake.inFlightWork?.trim()) missing.push("inFlightWork");
      if (missing.length) {
        return {
          ok: false,
          error: "validation_failed",
          message: `codebase intake missing required fields: ${missing.join(", ")}`,
          missing,
        };
      }
      const recorded: PlanningIntakeArtifact = {
        recordedAt: nowIso(),
        projectShape: intake.projectShape.trim(),
        testStack: intake.testStack.trim(),
        ancillarySurfaces: dedupeStrings(intake.ancillarySurfaces),
        ...(intake.docMap?.trim() ? { docMap: intake.docMap.trim() } : {}),
        inFlightWork: intake.inFlightWork.trim(),
        ciGates: dedupeStrings(intake.ciGates),
      };
      const res = await directPatch(
        runtime,
        [
          { op: "replace", path: "/leadState/planning/intake", value: recorded },
          {
            op: "replace",
            path: "/leadState/planning/stage",
            value: advancePlanningStagePastSkipped(
              "round_functional",
              (planning.overrides?.skippedRounds ?? []).filter((kind) =>
                hasSkippedRoundUserOverride(runtime.manifest!, kind),
              ),
            ),
          },
        ],
        "planning: codebase intake recorded",
      );
      return { ok: true, manifest: res.manifest, etag: res.etag };
    });
  }

  async function recordPlanningRound(
    runId: string,
    bundlePath: string,
    round: PlanningRoundRecord,
  ): Promise<PlanningMutationResult> {
    return runPlanningMutation(runId, bundlePath, async (runtime) => {
      const planning = planningOf(runtime.manifest!);
      if (!round.question?.trim()) {
        return { ok: false, error: "validation_failed", message: "round.question is required" };
      }
      if (!round.lockedSummary?.trim()) {
        return { ok: false, error: "validation_failed", message: "round.lockedSummary is required" };
      }
      const hasAnswer =
        Boolean(round.answeredAt?.trim()) &&
        ((round.selectedOptionIds?.length ?? 0) > 0 || Boolean(round.freeText?.trim()));
      if (!hasAnswer) {
        return {
          ok: false,
          error: "round_unanswered",
          message:
            "a planning round can only be recorded once the user has answered it (needs answeredAt + a selection or free-text)",
        };
      }
      const isCascade = Boolean(round.cascadedFrom?.trim());
      const expectedStage: Record<PlanningRoundKind, PlanningStage> = {
        functional: "round_functional",
        ui: "round_ui",
        extras: "round_extras",
      };
      if (!isCascade) {
        const want = expectedStage[round.kind];
        if (planning.stage !== want) {
          return {
            ok: false,
            error: "stage_conflict",
            message: `the ${round.kind} round can only be recorded at stage ${want}; current stage is ${planning.stage}`,
          };
        }
      } else if (planning.stage === "intake") {
        return {
          ok: false,
          error: "stage_conflict",
          message: "cannot record a cascade round before codebase intake",
        };
      }
      const record: PlanningRoundRecord = {
        id: round.id?.trim() || `PR-${round.kind}-${shortRand()}`,
        kind: round.kind,
        askedAt: round.askedAt?.trim() || nowIso(),
        question: round.question.trim(),
        ...(round.options?.length ? { options: round.options } : {}),
        ...(round.multiSelect ? { multiSelect: true } : {}),
        ...(round.selectedOptionIds?.length ? { selectedOptionIds: round.selectedOptionIds } : {}),
        ...(round.freeText?.trim() ? { freeText: round.freeText.trim() } : {}),
        lockedSummary: round.lockedSummary.trim(),
        ...(isCascade ? { cascadedFrom: round.cascadedFrom!.trim() } : {}),
        answeredAt: round.answeredAt!.trim(),
      };
      const ops: ManifestPatchOp[] = [
        { op: "add", path: "/leadState/planning/rounds/-", value: record },
      ];
      if (!isCascade) {
        const rawNextStage: PlanningStage =
          round.kind === "functional"
            ? "round_ui"
            : round.kind === "ui"
              ? "round_extras"
              : "rounds_complete";
        const nextStage = advancePlanningStagePastSkipped(
          rawNextStage,
          planning.overrides?.skippedRounds ?? [],
        );
        ops.push({ op: "replace", path: "/leadState/planning/stage", value: nextStage });
      }
      const res = await directPatch(
        runtime,
        ops,
        `planning: ${round.kind} round recorded${isCascade ? " (cascade)" : ""}`,
      );
      return { ok: true, manifest: res.manifest, etag: res.etag };
    });
  }

  async function recordPlanningOverride(
    runId: string,
    bundlePath: string,
    override: { skippedRounds?: PlanningRoundKind[]; skipReason?: string },
  ): Promise<PlanningMutationResult> {
    return runPlanningMutation(runId, bundlePath, async (runtime) => {
      const planning = planningOf(runtime.manifest!);
      const validKinds: PlanningRoundKind[] = ["functional", "ui", "extras"];
      const skipped = (override.skippedRounds ?? []).filter((k): k is PlanningRoundKind =>
        validKinds.includes(k),
      );
      const skipReason = override.skipReason?.trim() ?? "";
      const validationWaived = isExplicitValidationWaiverEntry({
        scope: "phase",
        appliedToId: "planning",
        instruction: skipReason,
        affectedDefault: "validation",
      });
      if (skipped.length && !skipReason) {
        return {
          ok: false,
          error: "override_reason_required",
          message: "skipping planning rounds requires the literal user instruction as skipReason",
        };
      }
      if (!skipped.length && !validationWaived) {
        return {
          ok: false,
          error: "override_empty",
          message: "recordPlanningOverride requires skippedRounds or an explicit skip-validation instruction",
        };
      }
      const nextSkipped = Array.from(
        new Set([...(planning.overrides?.skippedRounds ?? []), ...skipped]),
      );
      const value = {
        ...(nextSkipped.length ? { skippedRounds: nextSkipped } : {}),
        ...(skipReason ? { skipReason } : {}),
      };
      const ops: ManifestPatchOp[] = [
        { op: "replace", path: "/leadState/planning/overrides", value },
      ];
      const at = nowIso();
      for (const kind of skipped) {
        ops.push({
          op: "add",
          path: "/userOverrides/-",
          value: {
            id: `UO-${kind}-${shortRand()}`,
            at,
            scope: "phase",
            appliedToId: "planning",
            instruction: skipReason,
            affectedDefault: `planning.round.${kind}`,
          },
        });
      }
      if (validationWaived) {
        ops.push({
          op: "add",
          path: "/userOverrides/-",
          value: {
            id: `UO-validation-${shortRand()}`,
            at,
            scope: "phase",
            appliedToId: "planning",
            instruction: skipReason,
            affectedDefault: "validation",
          },
        });
      }
      const stage = advancePlanningStagePastSkipped(planning.stage, nextSkipped);
      if (stage !== planning.stage) {
        ops.push({ op: "replace", path: "/leadState/planning/stage", value: stage });
      }
      const res = await directPatch(runtime, ops, "planning: user override recorded");
      return { ok: true, manifest: res.manifest, etag: res.etag };
    });
  }

  function planningReadinessMissing(manifest: OrchestrationManifest): string[] {
      const planning = planningOf(manifest);
      const missing: string[] = [];
      if (!planning.intake) missing.push("codebase intake");
      const skipped = new Set(
        (planning.overrides?.skippedRounds ?? []).filter((kind) =>
          hasSkippedRoundUserOverride(manifest, kind),
        ),
      );
      for (const kind of ["functional", "ui", "extras"] as PlanningRoundKind[]) {
        if (skipped.has(kind)) continue;
        if (!planning.rounds.some((r) => r.kind === kind && !r.cascadedFrom)) {
          missing.push(`${kind} deliberation round`);
        }
      }
      const validationWaived = hasExplicitValidationWaiver(manifest);
      if (!validationWaived && manifest.validationStrategy.steps.length === 0) {
        missing.push("validation steps (derive at least one, or log a skip-validation user override)");
      }
      if (!hasOrchestrationModelRouting(manifest)) {
        missing.push("model routing (pick a model for at least one role/tag before approval)");
      }
      return missing;
  }

  async function checkPlanningReady(
    runId: string,
    bundlePath: string,
  ): Promise<PlanningMutationResult> {
    return runPlanningMutation(runId, bundlePath, async (runtime) => {
      const manifest = runtime.manifest!;
      const missing = planningReadinessMissing(manifest);
      if (missing.length) {
        return {
          ok: false,
          error: "planning_incomplete",
          message: `planning is not ready — still missing: ${missing.join("; ")}`,
          missing,
        };
      }
      return { ok: true, manifest, etag: manifest.etag };
    });
  }

  async function markPlanningReady(
    runId: string,
    bundlePath: string,
  ): Promise<PlanningMutationResult> {
    return runPlanningMutation(runId, bundlePath, async (runtime) => {
      const manifest = runtime.manifest!;
      const missing = planningReadinessMissing(manifest);
      if (missing.length) {
        return {
          ok: false,
          error: "planning_incomplete",
          message: `planning is not ready — still missing: ${missing.join("; ")}`,
          missing,
        };
      }
      const requestedAt = nowIso();
      const res = await directPatch(
        runtime,
        [
          { op: "replace", path: "/leadState/planning/stage", value: "ready" },
          { op: "replace", path: "/planSpec/approval/state", value: "ready" },
          { op: "replace", path: "/planSpec/approval/requestedAt", value: requestedAt },
        ],
        "planning: marked ready for approval",
      );
      return { ok: true, manifest: res.manifest, etag: res.etag };
    });
  }

  /**
   * Single privileged mutator for plan-approval transitions. On `approved` it
   * also writes the legacy approval markers and advances planning → developing,
   * replacing the patch block the old requestPlanApproval tool built inline.
   */
  async function setPlanApprovalState(
    runId: string,
    bundlePath: string,
    args: { state: PlanSpecApprovalState; sessionId?: string; planContentHash?: string },
  ): Promise<PlanningMutationResult> {
    return runPlanningMutation(runId, bundlePath, async (runtime) => {
      const manifest = runtime.manifest!;
      if (args.state === "approved") {
        const missing = planningReadinessMissing(manifest);
        if (missing.length) {
          return {
            ok: false,
            error: "planning_incomplete",
            message: `planning is not ready — still missing: ${missing.join("; ")}`,
            missing,
          };
        }
      }
      const at = nowIso();
      const ops: ManifestPatchOp[] = [
        { op: "replace", path: "/planSpec/approval/state", value: args.state },
      ];
      if (args.state === "ready") {
        ops.push({ op: "replace", path: "/planSpec/approval/requestedAt", value: at });
      }
      if (args.state === "changes_requested" && args.planContentHash) {
        ops.push({
          op: "replace",
          path: "/planSpec/approval/lastReviewedPlanContentHash",
          value: args.planContentHash,
        });
      }
      if (args.state === "approved") {
        ops.push(
          { op: "replace", path: "/planSpec/approval/approvedAt", value: at },
          ...(args.sessionId
            ? [{ op: "replace" as const, path: "/planSpec/approval/approvedBySessionId", value: args.sessionId }]
            : []),
          ...(args.planContentHash
            ? [{ op: "replace" as const, path: "/planSpec/approval/approvedPlanContentHash", value: args.planContentHash }]
            : []),
          { op: "replace", path: "/leadState/planning/stage", value: "ready" },
          { op: "replace", path: "/leadState/planApprovedAt", value: at },
          ...(args.sessionId
            ? [{ op: "replace" as const, path: "/leadState/planApprovedBySessionId", value: args.sessionId }]
            : []),
          { op: "replace", path: "/currentPhase", value: "developing" },
          { op: "replace", path: "/phases/{id:planning}/status", value: "done" },
          { op: "replace", path: "/phases/{id:planning}/completedAt", value: at },
          { op: "replace", path: "/phases/{id:developing}/status", value: "active" },
          { op: "replace", path: "/phases/{id:developing}/startedAt", value: at },
        );
      }
      const res = await directPatch(runtime, ops, `plan approval → ${args.state}`);
      return { ok: true, manifest: res.manifest, etag: res.etag };
    });
  }

  /**
   * Crash-resume primitive: reset any claimed/in-progress task whose claim lease
   * has expired back to `pending` and clear its assignee, so the lead can
   * re-dispatch work a dead worker abandoned. The manifest already survives
   * restarts on disk; this recovers the in-flight claims that outlived a worker.
   */
  async function releaseStaleClaims(
    runId: string,
    bundlePath: string,
  ): Promise<
    | { ok: true; manifest: OrchestrationManifest; etag: string; recovered: string[] }
    | { ok: false; error: string; message: string; recovered: string[] }
  > {
    const runtime = getOrCreateRuntime(runId, bundlePath);
    return runtime.mutex.run(async () => {
      await loadIntoRuntime(runtime);
      if (runtime.suspended) {
        return { ok: false, error: "run_suspended", message: RUN_SUSPENDED_MESSAGE, recovered: [] };
      }
      const manifest = runtime.manifest;
      if (!manifest) {
        return { ok: false, error: "run_not_found", message: `run ${runId} not found`, recovered: [] };
      }
      const nowMs = now().getTime();
      const stale = manifest.tasks.filter(
        (task) => {
          if (task.status !== "claimed" && task.status !== "in_progress") return false;
          const leaseMs =
            typeof task.claimLeaseUntil === "string" ? Date.parse(task.claimLeaseUntil) : NaN;
          return !Number.isFinite(leaseMs) || leaseMs <= nowMs;
        },
      );
      if (!stale.length) {
        return { ok: true, manifest, etag: manifest.etag, recovered: [] };
      }
      const ops: ManifestPatchOp[] = [];
      for (const task of stale) {
        ops.push({ op: "replace", path: `/tasks/{id:${task.id}}/status`, value: "pending" });
        if (task.assigneeSessionId !== undefined) {
          ops.push({ op: "remove", path: `/tasks/{id:${task.id}}/assigneeSessionId` });
        }
        if (task.claimedAt !== undefined) {
          ops.push({ op: "remove", path: `/tasks/{id:${task.id}}/claimedAt` });
        }
        if (task.claimLeaseUntil !== undefined) {
          ops.push({ op: "remove", path: `/tasks/{id:${task.id}}/claimLeaseUntil` });
        }
      }
      try {
        const res = await directPatch(runtime, ops, `recover ${stale.length} stale task(s)`);
        return { ok: true, manifest: res.manifest, etag: res.etag, recovered: stale.map((t) => t.id) };
      } catch (err) {
        if (err instanceof OrchestrationRunSuspendedError) {
          return { ok: false, error: "run_suspended", message: RUN_SUSPENDED_MESSAGE, recovered: [] };
        }
        throw err;
      }
    });
  }

  async function relocateRunBundle(runId: string, bundlePath: string): Promise<void> {
    const runtime = runs.get(runId);
    if (!runtime) return;
    await runtime.mutex.run(async () => {
      relocateRuntimeBundlePath(runtime, bundlePath);
      await loadIntoRuntime(runtime);
      if (runtime.manifest) {
        await startWatcher(runtime);
      }
    });
  }

  return {
    runCreate,
    relocateRunBundle,
    bundleRead,
    manifestReadSection,
    manifestPatch,
    planAppend,
    planWrite,
    assetRegister,
    claimTask,
    releaseTask,
    recordValidationRun,
    agentHeartbeat,
    approvePlan,
    recordPlanningIntake,
    recordPlanningRound,
    recordPlanningOverride,
    checkPlanningReady,
    markPlanningReady,
    setPlanApprovalState,
    releaseStaleClaims,
    runList,
    subscribe,
    release,
    dispose,
    on,
    getManifestForRun,
    getBundlePathForRun,
    /** Test helper — derives the bundle path for a (laneId, runId) pair. */
    bundleRootFor,
  };
}

export type OrchestrationService = ReturnType<typeof createOrchestrationService>;

// ----------------------------------------------------------------------------
// helpers (exported only for tests)
// ----------------------------------------------------------------------------

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `R-${ts}-${shortRand()}`;
}

function shortRand(): string {
  return crypto.randomBytes(3).toString("hex");
}

function escapeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function hasSkippedRoundUserOverride(
  manifest: OrchestrationManifest,
  kind: PlanningRoundKind,
): boolean {
  return manifest.userOverrides.some(
    (entry) =>
      entry.scope === "phase" &&
      entry.appliedToId === "planning" &&
      entry.affectedDefault === `planning.round.${kind}` &&
      entry.instruction.trim().length > 0,
  );
}

function advancePlanningStagePastSkipped(
  currentStage: PlanningStage,
  skippedRounds: PlanningRoundKind[],
): PlanningStage {
  const order: PlanningStage[] = [
    "round_functional",
    "round_ui",
    "round_extras",
    "rounds_complete",
  ];
  const stageKind: Partial<Record<PlanningStage, PlanningRoundKind>> = {
    round_functional: "functional",
    round_ui: "ui",
    round_extras: "extras",
  };
  let stage = currentStage;
  while (stageKind[stage] && skippedRounds.includes(stageKind[stage]!)) {
    const idx = order.indexOf(stage);
    if (idx < 0 || idx + 1 >= order.length) break;
    stage = order[idx + 1]!;
  }
  return stage;
}

function initialPlanMd(manifest: OrchestrationManifest): string {
  return `# ${manifest.title}\n\n<sub>run id: ${manifest.runId} · lane: ${manifest.laneId} · created ${manifest.createdAt}</sub>\n\n## Goal\n\n${manifest.goalSummary || "_pending — the lead will fill this in_"}\n\n`;
}

// Re-export applyPatches for external consumers that import from this module
export { applyPatches } from "./applyPatches";

export function validateSpawnBrief(initialMessage: string): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const required of ORCHESTRATION_SPAWN_BRIEF_REQUIRED_SECTIONS) {
    const re = new RegExp(`^\\s*${escapeRe(required)}\\s*$`, "m");
    if (!re.test(initialMessage)) missing.push(required);
  }
  return { ok: missing.length === 0, missing };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const ORCHESTRATION_EVENT_CHANNEL_NAME = ORCHESTRATION_EVENT_CHANNEL;
