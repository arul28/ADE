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
  type OrchestrationRunCreateRequest,
  type OrchestrationRunCreateResponse,
  type OrchestrationTaskStatus,
} from "../../../shared/types/orchestration";
import {
  checkPatchOp,
  isTaskHumanOverridePatch,
  isTaskStatusDonePatch,
  isUserOverrideEntryAppend,
  isValidationGateRequiredOff,
} from "./patchPolicy";

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

const MANIFEST_FILE = "manifest.json";
const PLAN_FILE = "plan.md";
const GEN_FILE = ".gen";
const HISTORY_RING_LIMIT = 50;
const SELF_WRITE_WINDOW_MS = 1_000;
const WATCHER_DEBOUNCE_MS = 50;

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
  watcherDebounceTimer: NodeJS.Timeout | null;
  suspended: boolean;
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
  const now = deps.now ?? (() => new Date());

  function nowIso(): string {
    return now().toISOString();
  }

  function bundleRootFor(laneId: string, runId: string): string {
    const worktree = deps.resolveLaneWorktree(laneId);
    if (!worktree) {
      throw new Error(`unknown laneId ${laneId} — cannot resolve worktree`);
    }
    return path.join(worktree, ".ade", "orchestration", runId);
  }

  async function ensureBundleDir(bundlePath: string): Promise<void> {
    await fsp.mkdir(path.join(bundlePath, "artifacts"), { recursive: true });
    await fsp.mkdir(path.join(bundlePath, "artifacts", "ui"), { recursive: true });
    await fsp.mkdir(path.join(bundlePath, "artifacts", "evidence"), {
      recursive: true,
    });
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

  async function atomicWrite(target: string, contents: string): Promise<void> {
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
    await fsp.rename(tmp, target);
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
        watcherDebounceTimer: null,
        suspended: false,
      };
      runs.set(runId, runtime);
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
        throw new Error(
          `manifest.runId ${manifest.runId} does not match expected ${runtime.runId}`,
        );
      }
      runtime.manifest = manifest;
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

  function emit(payload: OrchestrationEventPayload): void {
    emitter.emit("event", payload);
  }

  function markSelfWrite(runtime: RunRuntime): void {
    runtime.recentSelfWriteUntil = Date.now() + SELF_WRITE_WINDOW_MS;
  }

  async function startWatcher(runtime: RunRuntime): Promise<void> {
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
    const debouncedReload = (kind: "manifest" | "plan"): void => {
      if (runtime.watcherDebounceTimer) {
        clearTimeout(runtime.watcherDebounceTimer);
      }
      runtime.watcherDebounceTimer = setTimeout(() => {
        runtime.watcherDebounceTimer = null;
        if (Date.now() < runtime.recentSelfWriteUntil) {
          return; // suppress self-emitted events
        }
        void handleExternalChange(runtime, kind);
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
        const next = JSON.parse(raw) as OrchestrationManifest;
        // Resilience: if runId mismatches (e.g. branch checkout swapped the
        // file), do not blindly etag-bump; mark suspended and ignore.
        if (next.runId !== runtime.runId) {
          runtime.suspended = true;
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
    const manifestPath = path.join(runtime.bundlePath, MANIFEST_FILE);
    markSelfWrite(runtime);
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
    await writeServerGeneration(runtime.bundlePath, manifest.serverGeneration);
    runtime.manifest = manifest;
  }

  async function persistPlan(runtime: RunRuntime, plan: string): Promise<void> {
    const planPath = path.join(runtime.bundlePath, PLAN_FILE);
    markSelfWrite(runtime);
    await atomicWrite(planPath, plan);
    runtime.planMd = plan;
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
        leadState: { lastSnapshotEtag: etag, lastSnapshotSeenAt: createdAt },
        history: [
          { etag, at: createdAt, summary: "run created", patchKindSummary: "init" },
        ],
      };
      await persistManifest(runtime, manifest);
      await persistPlan(runtime, initialPlanMd(manifest));
      await startWatcher(runtime);
      runtime.refCount++;
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
      await startWatcher(runtime);
      runtime.refCount++;
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
          const checklistOk = task.validationGate.stepIds.every((sid) => {
            const items = current.validationStrategy.checklist.filter(
              (c) => c.stepId === sid && (!c.taskId || c.taskId === taskId),
            );
            if (!items.length) return false;
            return items.every((it) => {
              const latest = it.runs.find((r) => r.id === it.latestRunId);
              return latest?.status === "passed";
            });
          });
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

      const next = applyPatches(current, req.patches);
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

      await persistManifest(runtime, next);
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
      const manifest = runtime.manifest!;
      const task = manifest.tasks.find((t) => t.id === req.taskId);
      if (!task) {
        return {
          ok: false,
          reason: `task ${req.taskId} not found`,
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
      const patchRes = await directPatch(runtime, ops, "release");
      return { manifest: patchRes.manifest, etag: patchRes.etag };
    });
  }

  async function runList(laneId?: string): Promise<OrchestrationRunSummary[]> {
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
    return out;
  }

  /** Release a subscriber's reference; closes watcher when refCount hits zero. */
  async function release(runId: string): Promise<void> {
    const runtime = runs.get(runId);
    if (!runtime) return;
    runtime.refCount = Math.max(0, runtime.refCount - 1);
    if (runtime.refCount === 0 && runtime.watcher) {
      await runtime.watcher.close();
      runtime.watcher = null;
    }
  }

  async function dispose(): Promise<void> {
    for (const runtime of runs.values()) {
      if (runtime.watcher) await runtime.watcher.close();
      if (runtime.watcherDebounceTimer) clearTimeout(runtime.watcherDebounceTimer);
    }
    runs.clear();
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
    if (!runtime.manifest) throw new Error("manifest not loaded");
    const next = applyPatches(runtime.manifest, patches);
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

  return {
    runCreate,
    bundleRead,
    manifestReadSection,
    manifestPatch,
    planAppend,
    planWrite,
    assetRegister,
    claimTask,
    releaseTask,
    runList,
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

function extractTaskIdFromPath(path: string): string | null {
  const m = /\/tasks\/\{id:([^}]+)\}/.exec(path);
  return m ? m[1]! : null;
}

function initialPlanMd(manifest: OrchestrationManifest): string {
  return `# ${manifest.title}\n\n<sub>run id: ${manifest.runId} · lane: ${manifest.laneId} · created ${manifest.createdAt}</sub>\n\n## Goal\n\n${manifest.goalSummary || "_pending — the lead will fill this in_"}\n\n`;
}

/**
 * Apply a list of RFC-6902 subset patches to a manifest. Returns a fresh
 * (deep-cloned) manifest. Throws on invalid paths. Arrays are addressed by
 * id-predicate segments — `/tasks/{id:T-1}/...`.
 */
export function applyPatches(
  manifest: OrchestrationManifest,
  patches: readonly ManifestPatchOp[],
): OrchestrationManifest {
  const next = structuredClone(manifest) as OrchestrationManifest;
  for (const op of patches) {
    applyPatch(next, op);
  }
  return next;
}

function applyPatch(root: unknown, op: ManifestPatchOp): void {
  const segments = op.path
    .slice(1)
    .split("/")
    .filter((s) => s.length > 0);
  if (!segments.length) throw new Error("patch path empty");
  let parent: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    parent = navigate(parent, segments[i]!, false);
  }
  const last = segments[segments.length - 1]!;
  setOrRemove(parent, last, op);
}

const PREDICATE_RE = /^\{([a-zA-Z][a-zA-Z0-9]*):([^}]+)\}$/;

function navigate(parent: unknown, segment: string, createMissing: boolean): unknown {
  if (parent == null) throw new Error("cannot navigate into null/undefined");
  const match = PREDICATE_RE.exec(segment);
  if (match) {
    const [, field, value] = match;
    if (!Array.isArray(parent)) {
      throw new Error(`predicate segment {${field}:${value}} requires array parent`);
    }
    const found = (parent as Array<Record<string, unknown>>).find(
      (entry) => entry?.[field!] === value,
    );
    if (!found) throw new Error(`predicate ${field}=${value} matched no entry`);
    return found;
  }
  if (segment === "-") {
    throw new Error("'-' append segment only valid in trailing position");
  }
  if (Array.isArray(parent)) {
    throw new Error(`numeric/string index segments not allowed on arrays (got "${segment}")`);
  }
  const obj = parent as Record<string, unknown>;
  if (!(segment in obj)) {
    if (createMissing) obj[segment] = {};
    else throw new Error(`path segment "${segment}" does not exist`);
  }
  return obj[segment];
}

function setOrRemove(parent: unknown, last: string, op: ManifestPatchOp): void {
  const match = PREDICATE_RE.exec(last);
  if (match) {
    const [, field, value] = match;
    if (!Array.isArray(parent)) {
      throw new Error(`predicate segment {${field}:${value}} requires array parent`);
    }
    const arr = parent as Array<Record<string, unknown>>;
    const idx = arr.findIndex((e) => e?.[field!] === value);
    if (op.op === "remove") {
      if (idx === -1) return;
      arr.splice(idx, 1);
      return;
    }
    if (idx === -1) {
      if (op.op === "add") {
        arr.push(op.value as Record<string, unknown>);
      } else {
        throw new Error(`predicate ${field}=${value} matched no entry to replace`);
      }
      return;
    }
    if (op.op === "add") {
      throw new Error(
        `add op against existing entry ${field}=${value} — use replace instead`,
      );
    }
    arr[idx] = op.value as Record<string, unknown>;
    return;
  }
  if (last === "-") {
    if (!Array.isArray(parent)) {
      throw new Error("'-' append segment requires array parent");
    }
    if (op.op !== "add") {
      throw new Error("'-' append segment only valid with add");
    }
    (parent as unknown[]).push(op.value);
    return;
  }
  if (Array.isArray(parent)) {
    throw new Error(`literal segment "${last}" not allowed on array`);
  }
  const obj = parent as Record<string, unknown>;
  if (op.op === "remove") {
    delete obj[last];
    return;
  }
  obj[last] = op.value;
}

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
