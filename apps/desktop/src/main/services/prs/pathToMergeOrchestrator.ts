/**
 * Path to Merge orchestrator.
 *
 * Launches a single, visible, persistent chat agent per PR that watches the PR
 * and drives it to merge itself — modelled on the `/shipLane` loop, but the
 * agent (not a TypeScript state machine) owns every judgment: when CI/review
 * are terminal, how to fix failures, how to resolve conflicts, and which merge
 * tactic to use.
 *
 * The only piece that must stay deterministic is the wake-up timer: no chat
 * runtime can self-wake, so a thin main-process scheduler injects a "watch
 * turn" into the visible session every `pollIntervalSeconds` via
 * {@link createAgentChatService.runSessionTurn} (the same awaitable
 * turn-injection the CTO heartbeat uses). After each turn, ground truth for
 * "is it merged" comes from {@link createPrService.refresh} — never the agent's
 * self-report — so the loop can't be fooled into thinking it is done.
 *
 * The standing contract handed to the agent is built by
 * {@link buildPathToMergeSeedPrompt}; gating (CI / comments / both),
 * additional operator instructions, and the poll interval are encoded there as
 * hard rules.
 */

import fs from "node:fs";
import { getModelById, resolveChatProviderForDescriptor } from "../../../shared/modelRegistry";
import { mapPermissionModeForModelFamily } from "./resolverUtils";
import {
  buildPathToMergeSeedPrompt,
  buildWatchTurnPrompt,
  pathToMergeChatTitle,
} from "./pathToMergeSeedPrompt";
import type { Logger } from "../logging/logger";
import { nowIso, getErrorMessage } from "../shared/utils";
import type { createIssueInventoryService } from "./issueInventoryService";
import type { createPrService } from "./prService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { LaneWorktreeLockService } from "../lanes/laneWorktreeLockService";
import { LaneWorktreeLockedError } from "../lanes/laneWorktreeLockService";
import type {
  ConvergenceRuntimeState,
  LaneWorktreeLockBlocker,
  PathToMergeStartResult,
  PathToMergeStopResult,
  PrAgentPermissionMode,
  PrIssueResolutionScope,
  PrSummary,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Poll interval bounds
// ---------------------------------------------------------------------------

export const DEFAULT_POLL_INTERVAL_SECONDS = 600;
export const MIN_POLL_INTERVAL_SECONDS = 60;
export const MAX_POLL_INTERVAL_SECONDS = 3600;

/**
 * Hard ceiling on a single watch turn. A turn does one bounded unit of work
 * (diagnose, fix, commit, push, or merge) and ends — but a real CI fix can run
 * several minutes, so we give it well past the 5-min `runSessionTurn` default
 * to avoid interrupting the agent mid-push. If a turn truly runs this long,
 * something is wedged and interrupting is the right call.
 */
const WATCH_TURN_TIMEOUT_MS = 30 * 60_000;

export function clampPollIntervalSeconds(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_SECONDS;
  const seconds = Math.floor(value);
  if (seconds < MIN_POLL_INTERVAL_SECONDS) return MIN_POLL_INTERVAL_SECONDS;
  if (seconds > MAX_POLL_INTERVAL_SECONDS) return MAX_POLL_INTERVAL_SECONDS;
  return seconds;
}

function normalizeGating(scope: PrIssueResolutionScope | null | undefined): PrIssueResolutionScope {
  return scope === "checks" || scope === "comments" ? scope : "both";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PathToMergeDeps = {
  logger: Logger;
  prService: ReturnType<typeof createPrService>;
  laneService: ReturnType<typeof createLaneService>;
  agentChatService: Pick<
    ReturnType<typeof createAgentChatService>,
    "createSession" | "sendMessage" | "runSessionTurn" | "interrupt"
  >;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  laneWorktreeLockService: LaneWorktreeLockService;
  defaultModelId: string | null;
  defaultReasoningEffort: string | null;
};

export type StartPathToMergeArgs = {
  prId: string;
  /** Model used for the visible watcher chat. Falls back to `deps.defaultModelId`. */
  modelId?: string | null;
  /** Reasoning effort passed to the watcher chat. */
  reasoning?: string | null;
  /** Permission preset for the watcher chat. */
  permissionMode?: PrAgentPermissionMode | null;
  /** Which signals gate the merge: CI checks only, review comments only, or both. */
  scope?: PrIssueResolutionScope;
  /** Free-form operator instructions folded into the seed contract. */
  additionalInstructions?: string | null;
  /** Seconds between scheduler-injected watch turns. Clamped to [60, 3600]. */
  pollIntervalSeconds?: number | null;
};

export type PathToMergeOrchestrator = {
  startPathToMerge: (args: StartPathToMergeArgs) => Promise<PathToMergeStartResult>;
  stopPathToMerge: (args: { prId: string; reason?: string | null }) => Promise<PathToMergeStopResult>;
  /**
   * Re-arm watch-turn timers for any PR whose watcher was live when the desktop
   * app last shut down. Idempotent — keyed on `autoConvergeEnabled` plus a
   * non-terminal status and a persisted watcher session id.
   */
  resumeFromPersistedState: () => void;
  /** Stop all in-flight timers without mutating persisted state. */
  dispose: () => void;
};

/** Opaque blob persisted in `pr_convergence_state.ptm_args_json` for resume. */
type PersistedPtmArgs = {
  modelId: string | null;
  reasoning: string | null;
  permissionMode: PrAgentPermissionMode | null;
  scope: PrIssueResolutionScope;
  additionalInstructions: string | null;
  pollIntervalSeconds: number;
};

/** In-memory per-PR watcher handle (rebuilt from persistence on resume). */
type WatcherHandle = {
  sessionId: string;
  laneId: string;
  githubPrNumber: number;
  pollIntervalSeconds: number;
  reasoningEffort: string | undefined;
  lockToken: string | null;
};

const TERMINAL_RUNTIME_STATUSES = new Set<ConvergenceRuntimeState["status"]>([
  "merged",
  "stopped",
  "cancelled",
]);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPathToMergeOrchestrator(deps: PathToMergeDeps): PathToMergeOrchestrator {
  const {
    logger,
    issueInventoryService,
    prService,
    laneService,
    agentChatService,
    sessionService,
    laneWorktreeLockService,
  } = deps;

  const timersByPrId = new Map<string, NodeJS.Timeout>();
  const turnInFlight = new Map<string, boolean>();
  const watchers = new Map<string, WatcherHandle>();
  let disposed = false;

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  function clearTimer(prId: string): void {
    const handle = timersByPrId.get(prId);
    if (handle) {
      clearTimeout(handle);
      timersByPrId.delete(prId);
    }
  }

  function heartbeatLock(prId: string): void {
    const token = watchers.get(prId)?.lockToken?.trim();
    if (!token) return;
    try {
      const lock = laneWorktreeLockService.heartbeat(token);
      if (!lock) logger.warn("ptm.lock_heartbeat_missing", { prId });
    } catch (err) {
      logger.warn("ptm.lock_heartbeat_failed", { prId, error: getErrorMessage(err) });
    }
  }

  function scheduleWatch(prId: string, seconds: number): void {
    if (disposed) return;
    clearTimer(prId);
    heartbeatLock(prId);
    logger.info("ptm.schedule", { prId, seconds });
    const handle = setTimeout(() => {
      timersByPrId.delete(prId);
      void runWatchTurn(prId).catch((err) => {
        logger.error("ptm.watch_turn_unhandled", { prId, error: getErrorMessage(err) });
      });
    }, seconds * 1000);
    timersByPrId.set(prId, handle);
  }

  // -------------------------------------------------------------------------
  // Lane worktree lock
  // -------------------------------------------------------------------------

  function ptmOwnerLabel(pr: Pick<PrSummary, "githubPrNumber" | "title">): string {
    const title = pr.title?.trim();
    return `Path to Merge for PR #${pr.githubPrNumber}${title ? ` (${title})` : ""}`;
  }

  function acquirePtmLock(pr: PrSummary, token?: string | null): { token: string } {
    const lane = laneService.getLaneBaseAndBranch(pr.laneId);
    const acquired = laneWorktreeLockService.acquire({
      laneId: pr.laneId,
      worktreePath: lane.worktreePath,
      ownerKind: "path_to_merge",
      ownerPrId: pr.id,
      ownerLabel: ptmOwnerLabel(pr),
      token,
    });
    return { token: acquired.token };
  }

  function releasePtmLock(prId: string, token?: string | null): void {
    try {
      if (token?.trim()) {
        laneWorktreeLockService.release({ token });
      } else {
        laneWorktreeLockService.release({ ownerKind: "path_to_merge", ownerPrId: prId });
      }
    } catch (err) {
      logger.warn("ptm.lock_release_failed", { prId, error: getErrorMessage(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function findPr(prId: string): PrSummary | null {
    return prService.listAll().find((entry) => entry.id === prId) ?? null;
  }

  function resolveLane(pr: PrSummary): { id: string; worktreePath: string } {
    const lane = laneService.getLaneBaseAndBranch(pr.laneId);
    if (!lane?.worktreePath || !fs.existsSync(lane.worktreePath)) {
      throw new Error(
        "Path to Merge needs a linked PR with a live local lane worktree. Open the PR's lane, then try again.",
      );
    }
    return { id: pr.laneId, worktreePath: lane.worktreePath };
  }

  function stopWatcher(
    prId: string,
    patch: Partial<ConvergenceRuntimeState>,
  ): ConvergenceRuntimeState {
    clearTimer(prId);
    const watcher = watchers.get(prId) ?? null;
    watchers.delete(prId);
    releasePtmLock(prId, watcher?.lockToken ?? null);
    return issueInventoryService.saveConvergenceRuntime(prId, patch);
  }

  function blockStartOnLock(prId: string, blocker: LaneWorktreeLockBlocker): PathToMergeStartResult {
    const runtime = issueInventoryService.saveConvergenceRuntime(prId, {
      autoConvergeEnabled: false,
      status: "paused",
      pollerStatus: "paused",
      activeSessionId: null,
      activeLaneId: null,
      activeHref: null,
      pauseReason: blocker.message,
      errorMessage: null,
      lastPausedAt: nowIso(),
    });
    return { prId, scheduled: false, runtime, blockedBy: blocker };
  }

  /**
   * Ground-truth terminal check. Refreshes the PR from GitHub and, if it has
   * merged or closed, finishes cleanup and tears the watcher down. Returns true
   * when the loop should stop (terminal or unrecoverable), false to keep going.
   */
  async function groundTruthTerminal(prId: string): Promise<boolean> {
    try {
      await prService.refresh({ prId });
    } catch (err) {
      logger.warn("ptm.refresh_failed", { prId, error: getErrorMessage(err) });
    }
    const pr = findPr(prId);
    if (!pr) {
      stopWatcher(prId, {
        autoConvergeEnabled: false,
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
        pauseReason: "PR vanished after refresh.",
        errorMessage: null,
        lastPausedAt: nowIso(),
      });
      return true;
    }
    if (pr.state === "merged") {
      try {
        await prService.runPostMergeCleanup({ prId, mergeCommitSha: null, archiveLane: false });
      } catch (err) {
        logger.warn("ptm.post_merge_cleanup_failed", { prId, error: getErrorMessage(err) });
      }
      stopWatcher(prId, {
        autoConvergeEnabled: false,
        status: "merged",
        pollerStatus: "stopped",
        activeSessionId: null,
        pauseReason: null,
        errorMessage: null,
      });
      logger.info("ptm.merged", { prId });
      return true;
    }
    if (pr.state === "closed") {
      stopWatcher(prId, {
        autoConvergeEnabled: false,
        status: "stopped",
        pollerStatus: "stopped",
        activeSessionId: null,
        pauseReason: "PR was closed.",
        errorMessage: null,
        lastStoppedAt: nowIso(),
      });
      logger.info("ptm.closed", { prId });
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Watch turn (scheduler body)
  // -------------------------------------------------------------------------

  async function runWatchTurn(prId: string): Promise<void> {
    if (disposed) return;

    const runtime = issueInventoryService.getConvergenceRuntime(prId);
    if (!runtime.autoConvergeEnabled) {
      clearTimer(prId);
      watchers.delete(prId);
      return;
    }

    const watcher = watchers.get(prId);
    if (!watcher?.sessionId) {
      stopWatcher(prId, {
        autoConvergeEnabled: false,
        status: "paused",
        pollerStatus: "paused",
        pauseReason: "Watcher chat session is missing; restart Path to Merge.",
        errorMessage: null,
        lastPausedAt: nowIso(),
      });
      return;
    }

    if (turnInFlight.get(prId)) {
      logger.debug("ptm.watch_turn_skipped_in_flight", { prId });
      scheduleWatch(prId, watcher.pollIntervalSeconds);
      return;
    }
    turnInFlight.set(prId, true);
    try {
      // Short-circuit if it merged between turns (e.g. an armed `--auto` landed).
      if (await groundTruthTerminal(prId)) return;

      issueInventoryService.saveConvergenceRuntime(prId, {
        status: "running",
        pollerStatus: "polling",
        lastPolledAt: nowIso(),
      });

      try {
        await agentChatService.runSessionTurn({
          sessionId: watcher.sessionId,
          text: buildWatchTurnPrompt({ githubPrNumber: watcher.githubPrNumber }),
          timeoutMs: WATCH_TURN_TIMEOUT_MS,
          ...(watcher.reasoningEffort ? { reasoningEffort: watcher.reasoningEffort } : {}),
        });
      } catch (err) {
        const message = getErrorMessage(err);
        if (/already has an active background turn/i.test(message)) {
          // The watcher (or the user) is mid-turn; just re-check next interval.
          logger.debug("ptm.watch_turn_busy", { prId });
        } else {
          logger.warn("ptm.watch_turn_failed", { prId, error: message });
          issueInventoryService.saveConvergenceRuntime(prId, { errorMessage: message });
        }
      }

      heartbeatLock(prId);

      // Ground truth after the turn — the agent may have merged it.
      if (await groundTruthTerminal(prId)) return;
      if (!issueInventoryService.getConvergenceRuntime(prId).autoConvergeEnabled) {
        clearTimer(prId);
        watchers.delete(prId);
        return;
      }

      issueInventoryService.saveConvergenceRuntime(prId, {
        status: "running",
        pollerStatus: "polling",
      });
      scheduleWatch(prId, watcher.pollIntervalSeconds);
    } finally {
      turnInFlight.set(prId, false);
    }
  }

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  async function startPathToMerge(args: StartPathToMergeArgs): Promise<PathToMergeStartResult> {
    const prId = args.prId.trim();
    if (!prId) throw new Error("prId is required");

    const pr = findPr(prId);
    if (!pr) throw new Error(`PR not found: ${prId}`);

    const lane = resolveLane(pr);

    const modelId = args.modelId?.trim() || deps.defaultModelId?.trim() || "";
    if (!modelId) throw new Error("A model is required to launch Path to Merge.");
    const descriptor = getModelById(modelId);
    if (!descriptor) throw new Error(`Unknown model '${modelId}'.`);
    const { provider, model } = resolveChatProviderForDescriptor(descriptor);
    const reasoningEffort = args.reasoning?.trim() || deps.defaultReasoningEffort?.trim() || undefined;

    const gating = normalizeGating(args.scope);
    const pollIntervalSeconds = clampPollIntervalSeconds(args.pollIntervalSeconds);
    const additionalInstructions = args.additionalInstructions?.trim() || null;

    let lockToken: string | null = null;
    try {
      lockToken = acquirePtmLock(pr).token;
    } catch (err) {
      if (err instanceof LaneWorktreeLockedError) {
        logger.info("ptm.start_blocked_by_lane_lock", { prId, blocker: err.blocker.message });
        return blockStartOnLock(prId, err.blocker);
      }
      throw err;
    }

    try {
      const session = await agentChatService.createSession({
        laneId: lane.id,
        provider,
        model,
        modelId: descriptor.id,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        permissionMode: mapPermissionModeForModelFamily(args.permissionMode ?? undefined, descriptor.family),
        surface: "work",
        sessionProfile: "workflow",
      });

      laneWorktreeLockService.attachSession(lockToken, session.id);

      const title = pathToMergeChatTitle(pr);
      sessionService.updateMeta({ sessionId: session.id, title });
      const href = `/work?laneId=${encodeURIComponent(lane.id)}&sessionId=${encodeURIComponent(session.id)}`;

      const persisted: PersistedPtmArgs = {
        modelId: descriptor.id,
        reasoning: args.reasoning?.trim() || null,
        permissionMode: args.permissionMode ?? null,
        scope: gating,
        additionalInstructions,
        pollIntervalSeconds,
      };
      issueInventoryService.savePathToMergeArgs(prId, persisted);

      const runtime = issueInventoryService.saveConvergenceRuntime(prId, {
        autoConvergeEnabled: true,
        status: "running",
        pollerStatus: "polling",
        activeSessionId: session.id,
        activeLaneId: lane.id,
        activeHref: href,
        pauseReason: null,
        errorMessage: null,
        lastStartedAt: nowIso(),
      });

      watchers.set(prId, {
        sessionId: session.id,
        laneId: lane.id,
        githubPrNumber: pr.githubPrNumber,
        pollIntervalSeconds,
        reasoningEffort,
        lockToken,
      });

      const seed = buildPathToMergeSeedPrompt({
        pr,
        laneWorktreePath: lane.worktreePath,
        gating,
        additionalInstructions,
        pollIntervalSeconds,
      });

      // Fire-and-forget the seed so Start returns immediately with a visible
      // first turn. The scheduler's awaitable watch turns drive the loop after.
      void agentChatService
        .sendMessage({ sessionId: session.id, text: seed, displayText: title, ...(reasoningEffort ? { reasoningEffort } : {}) })
        .catch((err) => logger.warn("ptm.seed_send_failed", { prId, error: getErrorMessage(err) }));

      scheduleWatch(prId, pollIntervalSeconds);
      logger.info("ptm.started", { prId, sessionId: session.id, gating, pollIntervalSeconds });
      return { prId, scheduled: true, runtime };
    } catch (err) {
      releasePtmLock(prId, lockToken);
      throw err;
    }
  }

  async function stopPathToMerge(args: { prId: string; reason?: string | null }): Promise<PathToMergeStopResult> {
    const prId = args.prId.trim();
    if (!prId) throw new Error("prId is required");

    clearTimer(prId);
    const watcher = watchers.get(prId) ?? null;
    watchers.delete(prId);

    const current = issueInventoryService.getConvergenceRuntime(prId);
    const sessionId = current.activeSessionId;
    if (sessionId) {
      try {
        await agentChatService.interrupt({ sessionId });
      } catch (err) {
        logger.warn("ptm.interrupt_failed", { prId, sessionId, error: getErrorMessage(err) });
      }
    }

    issueInventoryService.savePathToMergeArgs(prId, null);
    const runtime = issueInventoryService.saveConvergenceRuntime(prId, {
      autoConvergeEnabled: false,
      status: "stopped",
      pollerStatus: "stopped",
      activeSessionId: null,
      activeLaneId: null,
      activeHref: null,
      pauseReason: args.reason?.trim() || null,
      errorMessage: null,
      lastStoppedAt: nowIso(),
    });
    releasePtmLock(prId, watcher?.lockToken ?? null);

    return { prId, stopped: true, runtime };
  }

  function readPersistedArgs(prId: string): PersistedPtmArgs | null {
    const raw = issueInventoryService.getPathToMergeArgs(prId);
    if (!raw) return null;
    return {
      modelId: typeof raw.modelId === "string" ? raw.modelId : null,
      reasoning: typeof raw.reasoning === "string" ? raw.reasoning : null,
      permissionMode: typeof raw.permissionMode === "string" ? (raw.permissionMode as PrAgentPermissionMode) : null,
      scope: normalizeGating(raw.scope as PrIssueResolutionScope | undefined),
      additionalInstructions: typeof raw.additionalInstructions === "string" ? raw.additionalInstructions : null,
      pollIntervalSeconds: clampPollIntervalSeconds(
        typeof raw.pollIntervalSeconds === "number" ? raw.pollIntervalSeconds : null,
      ),
    };
  }

  function resumeFromPersistedState(): void {
    if (disposed) return;
    for (const pr of prService.listAll()) {
      const runtime = issueInventoryService.getConvergenceRuntime(pr.id);
      if (!runtime.autoConvergeEnabled) continue;
      if (runtime.pollerStatus === "stopped") continue;
      if (TERMINAL_RUNTIME_STATUSES.has(runtime.status)) continue;

      const sessionId = runtime.activeSessionId?.trim() || "";
      if (!sessionId) {
        // Stale flag with no live watcher chat — clear it instead of warming a
        // doomed loop.
        logger.info("ptm.resume_clearing_stale_flag", { prId: pr.id });
        issueInventoryService.saveConvergenceRuntime(pr.id, {
          autoConvergeEnabled: false,
          status: "stopped",
          pollerStatus: "stopped",
          pauseReason: null,
          errorMessage: null,
          lastStoppedAt: nowIso(),
        });
        issueInventoryService.savePathToMergeArgs(pr.id, null);
        continue;
      }

      const persisted = readPersistedArgs(pr.id);
      const pollIntervalSeconds = persisted?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
      const reasoningEffort = persisted?.reasoning?.trim() || deps.defaultReasoningEffort?.trim() || undefined;

      let lockToken: string | null = null;
      try {
        lockToken = acquirePtmLock(pr).token;
      } catch (err) {
        const message = err instanceof LaneWorktreeLockedError ? err.blocker.message : getErrorMessage(err);
        logger.info("ptm.resume_blocked", { prId: pr.id, reason: message });
        issueInventoryService.saveConvergenceRuntime(pr.id, {
          autoConvergeEnabled: false,
          status: "paused",
          pollerStatus: "paused",
          pauseReason: message,
          errorMessage: null,
          lastPausedAt: nowIso(),
        });
        continue;
      }

      watchers.set(pr.id, {
        sessionId,
        laneId: runtime.activeLaneId?.trim() || pr.laneId,
        githubPrNumber: pr.githubPrNumber,
        pollIntervalSeconds,
        reasoningEffort,
        lockToken,
      });
      scheduleWatch(pr.id, pollIntervalSeconds);
      logger.info("ptm.resumed", { prId: pr.id, sessionId, pollIntervalSeconds });
    }
  }

  function dispose(): void {
    disposed = true;
    for (const handle of timersByPrId.values()) clearTimeout(handle);
    timersByPrId.clear();
    turnInFlight.clear();
    watchers.clear();
  }

  return { startPathToMerge, stopPathToMerge, resumeFromPersistedState, dispose };
}
