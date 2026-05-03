/**
 * Path to Merge orchestrator.
 *
 * Native TypeScript port of the `/shipLane` Claude skill state machine
 * (`.claude/commands/shipLane.md`). Drives a PR through CI + review until
 * merged, using:
 *   - phase-aware setTimeout wake-ups (270 / 720 / 1800 seconds; see
 *     {@link PHASE_DELAY_SECONDS});
 *   - a combined CI + review terminal-state gate before pushing fixes;
 *   - a 4-option conflict strategy (`pause | rebase | merge | auto`);
 *   - a hard cap on iterations with optional bonus force-finalize iteration;
 *   - an early-merge-on-green short circuit;
 *   - a merge ladder that tries the configured method, then `--admin`, then
 *     `--auto`.
 *
 * Persistence happens through the existing `pr_convergence_state` table via
 * `issueInventoryService` — no schema changes. The orchestrator runs ON TOP
 * of the existing manual entry points (`startPullRequestConvergenceRound`)
 * and dispatches each fix iteration via `launchPrIssueResolutionChat`.
 *
 * Simplifications vs `/shipLane`:
 *   - The shipLane reference relies on Claude Code's TeamCreate primitive to
 *     run a poll-agent + fix-agent + rebase-agent in parallel. ADE has no
 *     equivalent, so each iteration here dispatches a single fix agent
 *     through the standard `launchPrIssueResolutionChat` pipeline; that
 *     agent internally decides whether to fix CI, review comments, or both.
 *   - We do not implement the Phase 0 `automate-agent`/`finalize-agent` —
 *     this orchestrator assumes the PR already exists; PR creation is the
 *     caller's responsibility.
 */

import { spawn } from "node:child_process";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import { launchPrIssueResolutionChat } from "./prIssueResolver";
import { nowIso, getErrorMessage } from "../shared/utils";
import type { createIssueInventoryService } from "./issueInventoryService";
import type { createPrService } from "./prService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { createConflictService } from "../conflicts/conflictService";
import type {
  AutoConflictAgentSettings,
  ConflictStrategy,
  ConvergenceRuntimeState,
  ForceFinalizeMode,
  MergeMethod,
  PipelineSettings,
  PrCheck,
  PrIssueResolutionScope,
  PrSummary,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Phase delays (shipLane.md lines 89-91, exact values).
// ---------------------------------------------------------------------------

/**
 * Wake-up delays per phase, in seconds.
 *
 * Mirrors `/shipLane` playbook §5.3:
 *   - `justPushed` (270s, ~4.5 min): we just pushed a fix commit; wait for
 *     CI to start churning before re-polling.
 *   - `warming`   (720s, ~12 min): one of CI / review is still pending,
 *     reschedule and re-evaluate the terminal-state gate.
 *   - `waitingOnReview` (1800s, 30 min): everything else is settled, we are
 *     parked waiting on a human/bot reviewer signal.
 */
export const PHASE_DELAY_SECONDS = {
  justPushed: 270,
  warming: 720,
  waitingOnReview: 1800,
} as const;

type PhaseDelayKind = keyof typeof PHASE_DELAY_SECONDS;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PathToMergeDeps = {
  logger: Logger;
  prService: ReturnType<typeof createPrService>;
  laneService: ReturnType<typeof createLaneService>;
  agentChatService: Pick<
    ReturnType<typeof createAgentChatService>,
    "createSession" | "sendMessage" | "previewSessionToolNames" | "interrupt"
  >;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  conflictService: Pick<ReturnType<typeof createConflictService>, "runExternalResolver">;
  defaultModelId: string | null;
  defaultReasoningEffort: string | null;
};

export type StartPathToMergeArgs = {
  prId: string;
  /** Optional override for the agent model used for fix dispatches. */
  modelId?: string | null;
  /** Optional override for reasoning effort passed to the fix agent. */
  reasoning?: string | null;
  /** Scope passed to `launchPrIssueResolutionChat` per iteration. */
  scope?: PrIssueResolutionScope;
  /** Optional extra instructions appended to each iteration prompt. */
  additionalInstructions?: string | null;
};

export type StartPathToMergeResult = {
  prId: string;
  scheduled: boolean;
  runtime: ConvergenceRuntimeState;
};

export type StopPathToMergeResult = {
  prId: string;
  stopped: boolean;
  runtime: ConvergenceRuntimeState | null;
};

export type PathToMergeOrchestrator = {
  startPathToMerge: (args: StartPathToMergeArgs) => Promise<StartPathToMergeResult>;
  stopPathToMerge: (args: { prId: string; reason?: string | null }) => Promise<StopPathToMergeResult>;
  /**
   * Resume any persisted runtime states that were mid-flight when the
   * desktop app last shut down. Idempotent — relies on `pollerStatus` and
   * `autoConvergeEnabled` to decide whether to rearm a timer.
   */
  resumeFromPersistedState: () => void;
  /** Stop all in-flight timers without mutating persisted state. */
  dispose: () => void;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const CHECKS_TERMINAL_STATUSES = new Set<PrSummary["checksStatus"]>(["passing", "failing", "none"]);
const REVIEWS_TERMINAL_STATUSES = new Set<PrSummary["reviewStatus"]>(["approved", "changes_requested", "none"]);

/**
 * Combined CI + review terminal gate (shipLane.md line 206).
 * Both signals must be in a terminal state before we are allowed to push
 * another round of fixes — pushing on a partial signal causes thrashing.
 */
function isTerminalForFixPush(pr: PrSummary): { terminal: boolean; pendingSignal: "checks" | "review" | null } {
  const checksTerminal = CHECKS_TERMINAL_STATUSES.has(pr.checksStatus);
  const reviewTerminal = REVIEWS_TERMINAL_STATUSES.has(pr.reviewStatus);
  if (!checksTerminal) return { terminal: false, pendingSignal: "checks" };
  if (!reviewTerminal) return { terminal: false, pendingSignal: "review" };
  return { terminal: true, pendingSignal: null };
}

/**
 * Convergence row + resolved current settings + current PR snapshot.
 * Bundling them avoids redundant DB reads in the iteration body.
 */
type IterationContext = {
  pr: PrSummary;
  pipelineSettings: PipelineSettings;
  runtime: ConvergenceRuntimeState;
};

function resolveMergeMethod(settings: PipelineSettings): MergeMethod {
  // `repo_default` has no in-process source-of-truth for the repo's default
  // merge method — the GitHub merge REST API requires an explicit
  // merge_method, so we fall back to `squash` (matches shipLane's default).
  if (settings.mergeMethod === "repo_default") return "squash";
  return settings.mergeMethod;
}

// ---------------------------------------------------------------------------
// `gh` shell wrapper (used for the `--admin` and `--auto` rungs of the
// merge ladder; the first rung uses the existing `prService.land()` REST
// call, which is plenty for the happy path).
// ---------------------------------------------------------------------------

type GhRunResult = { exitCode: number; stdout: string; stderr: string };

async function runGh(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<GhRunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return await new Promise<GhRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const child = spawn("gh", args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      resolve({ exitCode: code, stdout, stderr });
    };

    timer = setTimeout(() => finish(124), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPathToMergeOrchestrator(deps: PathToMergeDeps): PathToMergeOrchestrator {
  const { logger, issueInventoryService, prService, laneService, agentChatService, sessionService, conflictService } = deps;

  /**
   * Map prId → in-flight `setTimeout` handle. Used so we can cancel a
   * pending wake-up when {@link stopPathToMerge} is called or when an
   * iteration triggers an early reschedule.
   */
  const timersByPrId = new Map<string, NodeJS.Timeout>();
  /**
   * Map prId → boolean indicating an iteration is currently executing.
   * Prevents double-scheduling when external callers also poke the loop.
   */
  const iterationInFlight = new Map<string, boolean>();
  /** Per-PR state we don't want to round-trip through the DB. */
  const inProcessState = new Map<string, { forceFinalizeUsed: boolean; runArgs: StartPathToMergeArgs }>();

  let disposed = false;

  // -------------------------------------------------------------------------
  // Scheduling primitive (mirrors prPollingService's setTimeout pattern).
  // -------------------------------------------------------------------------

  function clearTimer(prId: string): void {
    const handle = timersByPrId.get(prId);
    if (handle) {
      clearTimeout(handle);
      timersByPrId.delete(prId);
    }
  }

  function schedule(prId: string, kind: PhaseDelayKind): void {
    if (disposed) return;
    clearTimer(prId);
    const seconds = PHASE_DELAY_SECONDS[kind];
    logger.info("ptm.schedule", { prId, kind, seconds });
    const handle = setTimeout(() => {
      timersByPrId.delete(prId);
      void runIteration(prId).catch((err) => {
        logger.error("ptm.iteration_unhandled", { prId, error: getErrorMessage(err) });
      });
    }, seconds * 1000);
    timersByPrId.set(prId, handle);
  }

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  async function startPathToMerge(args: StartPathToMergeArgs): Promise<StartPathToMergeResult> {
    const prId = args.prId.trim();
    if (!prId) throw new Error("prId is required");

    inProcessState.set(prId, { forceFinalizeUsed: false, runArgs: args });

    const runtime = issueInventoryService.saveConvergenceRuntime(prId, {
      autoConvergeEnabled: true,
      status: "launching",
      pollerStatus: "scheduled",
      pauseReason: null,
      errorMessage: null,
      lastStartedAt: nowIso(),
    });

    // Kick the loop immediately rather than waiting for a phase delay —
    // operators expect "Start" to do something visible right away.
    clearTimer(prId);
    setImmediate(() => {
      void runIteration(prId).catch((err) => {
        logger.error("ptm.start_unhandled", { prId, error: getErrorMessage(err) });
      });
    });

    return { prId, scheduled: true, runtime };
  }

  async function stopPathToMerge(args: { prId: string; reason?: string | null }): Promise<StopPathToMergeResult> {
    const prId = args.prId.trim();
    if (!prId) throw new Error("prId is required");

    clearTimer(prId);
    inProcessState.delete(prId);

    const current = issueInventoryService.getConvergenceRuntime(prId);
    const activeSessionId = current.activeSessionId;
    if (activeSessionId) {
      try {
        await agentChatService.interrupt({ sessionId: activeSessionId });
      } catch (err) {
        logger.warn("ptm.interrupt_failed", { prId, sessionId: activeSessionId, error: getErrorMessage(err) });
      }
    }

    const runtime = issueInventoryService.saveConvergenceRuntime(prId, {
      autoConvergeEnabled: false,
      status: "stopped",
      pollerStatus: "stopped",
      activeSessionId: null,
      pauseReason: args.reason?.trim() || null,
      errorMessage: null,
      lastStoppedAt: nowIso(),
    });

    return { prId, stopped: true, runtime };
  }

  function resumeFromPersistedState(): void {
    if (disposed) return;
    // Find every PR whose convergence is still flagged as live and rearm the
    // scheduled wake-up. We rely on `autoConvergeEnabled === true` and
    // `pollerStatus !== 'stopped'` to identify candidates.
    const allPrs = prService.listAll();
    for (const pr of allPrs) {
      const runtime = issueInventoryService.getConvergenceRuntime(pr.id);
      if (!runtime.autoConvergeEnabled) continue;
      if (runtime.pollerStatus === "stopped") continue;
      if (runtime.status === "merged" || runtime.status === "stopped" || runtime.status === "cancelled") continue;
      // We don't have the original startPathToMerge args here — fall back to
      // sane defaults. The orchestrator's iteration logic re-reads pipeline
      // settings each iteration, so the outcome converges either way.
      inProcessState.set(pr.id, {
        forceFinalizeUsed: runtime.currentRound > readMaxRoundsForPr(pr.id),
        runArgs: { prId: pr.id, scope: "both" },
      });
      schedule(pr.id, "warming");
    }
  }

  function dispose(): void {
    disposed = true;
    for (const handle of timersByPrId.values()) {
      clearTimeout(handle);
    }
    timersByPrId.clear();
    iterationInFlight.clear();
    inProcessState.clear();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function readMaxRoundsForPr(prId: string): number {
    try {
      return issueInventoryService.getPipelineSettings(prId).maxRounds;
    } catch {
      return 5;
    }
  }

  function loadIterationContext(prId: string): IterationContext | null {
    const pr = prService.listAll().find((entry) => entry.id === prId) ?? null;
    if (!pr) return null;
    const pipelineSettings = issueInventoryService.getPipelineSettings(prId);
    const runtime = issueInventoryService.getConvergenceRuntime(prId);
    return { pr, pipelineSettings, runtime };
  }

  function pauseLoop(prId: string, reason: string, errorMessage?: string | null): ConvergenceRuntimeState {
    clearTimer(prId);
    return issueInventoryService.saveConvergenceRuntime(prId, {
      status: "paused",
      pollerStatus: "paused",
      pauseReason: reason,
      errorMessage: errorMessage ?? null,
      lastPausedAt: nowIso(),
      autoConvergeEnabled: false,
    });
  }

  function failLoop(prId: string, errorMessage: string): ConvergenceRuntimeState {
    clearTimer(prId);
    return issueInventoryService.saveConvergenceRuntime(prId, {
      status: "failed",
      pollerStatus: "stopped",
      errorMessage,
      autoConvergeEnabled: false,
    });
  }

  // -------------------------------------------------------------------------
  // Conflict strategy dispatcher
  // -------------------------------------------------------------------------

  type ConflictKind = "base_advance" | "merge_time";

  type ApplyConflictStrategyResult =
    | { kind: "ok" }
    | { kind: "paused"; reason: string }
    | { kind: "failed"; error: string };

  /**
   * Single helper called from two sites:
   *   - at the top of each iteration as a "base advance" sync (`base_advance`)
   *   - when the merge ladder fails on a conflict (`merge_time`)
   *
   * The behavior switches on `pipelineSettings.conflictStrategy`:
   *   - `pause` → mark the loop paused, exit
   *   - `rebase` → `git rebase origin/<base>` then force-push --force-with-lease
   *   - `merge`  → `git merge origin/<base>` then push the merge commit
   *   - `auto`   → invoke `conflictService.runExternalResolver` with the
   *               settings from `pipelineSettings.autoAgentSettings`.
   */
  async function applyConflictStrategy(
    ctx: IterationContext,
    kind: ConflictKind,
  ): Promise<ApplyConflictStrategyResult> {
    const { pr, pipelineSettings } = ctx;
    const strategy: ConflictStrategy = pipelineSettings.conflictStrategy;
    const lane = laneService.getLaneBaseAndBranch(pr.laneId);
    const cwd = lane.worktreePath;
    const baseRef = `origin/${pr.baseBranch}`;
    const branch = pr.headBranch;

    logger.info("ptm.conflict_strategy_apply", { prId: pr.id, strategy, kind });

    if (strategy === "pause") {
      return { kind: "paused", reason: `Conflict (${kind}): paused per pipeline settings.` };
    }

    // Always make sure origin is up to date before attempting the strategy.
    const fetchRes = await runGit(["fetch", "origin", pr.baseBranch], { cwd, timeoutMs: 60_000 });
    if (fetchRes.exitCode !== 0) {
      return { kind: "failed", error: `git fetch origin ${pr.baseBranch} failed: ${fetchRes.stderr.trim() || fetchRes.stdout.trim()}` };
    }

    if (strategy === "rebase") {
      const rebaseRes = await runGit(["rebase", baseRef], { cwd, timeoutMs: 180_000 });
      if (rebaseRes.exitCode !== 0) {
        // Best-effort cleanup so the worktree is not left in a half-rebased state.
        await runGit(["rebase", "--abort"], { cwd, timeoutMs: 30_000 }).catch(() => {});
        return { kind: "failed", error: `git rebase ${baseRef} failed: ${rebaseRes.stderr.trim() || rebaseRes.stdout.trim()}` };
      }
      const pushRes = await runGit(["push", "--force-with-lease", "origin", `HEAD:${branch}`], { cwd, timeoutMs: 120_000 });
      if (pushRes.exitCode !== 0) {
        return { kind: "failed", error: `force-push after rebase failed: ${pushRes.stderr.trim() || pushRes.stdout.trim()}` };
      }
      return { kind: "ok" };
    }

    if (strategy === "merge") {
      const mergeRes = await runGit(
        ["merge", "--no-edit", baseRef],
        { cwd, timeoutMs: 180_000 },
      );
      if (mergeRes.exitCode !== 0) {
        await runGit(["merge", "--abort"], { cwd, timeoutMs: 30_000 }).catch(() => {});
        return { kind: "failed", error: `git merge ${baseRef} failed: ${mergeRes.stderr.trim() || mergeRes.stdout.trim()}` };
      }
      const pushRes = await runGit(["push", "origin", `HEAD:${branch}`], { cwd, timeoutMs: 120_000 });
      if (pushRes.exitCode !== 0) {
        return { kind: "failed", error: `push after merge failed: ${pushRes.stderr.trim() || pushRes.stdout.trim()}` };
      }
      return { kind: "ok" };
    }

    // strategy === "auto" — let the conflict resolver agent decide. The
    // agent reads the worktree, picks rebase vs merge, and resolves any
    // marker-style conflicts itself.
    const autoSettings: AutoConflictAgentSettings = pipelineSettings.autoAgentSettings;
    const provider = autoSettings.provider;
    if (!provider) {
      return { kind: "failed", error: "Conflict strategy is 'auto' but no autoAgentSettings.provider is configured." };
    }

    try {
      const result = await conflictService.runExternalResolver({
        provider,
        targetLaneId: pr.laneId,
        sourceLaneIds: [pr.laneId],
        cwdLaneId: pr.laneId,
        model: autoSettings.model,
        reasoningEffort: autoSettings.reasoningEffort,
        permissionMode: autoSettings.permissionMode,
        // No "automation"/"path-to-merge" surface yet — closest existing
        // value is "rebase", which the resolver treats as a worktree-local
        // base-sync invocation (which is exactly what the PtM loop is doing
        // here).
        originSurface: "rebase",
        originLabel: `path-to-merge:${kind}:pr=${pr.githubPrNumber}`,
      });
      if (result.status === "completed") {
        return { kind: "ok" };
      }
      return { kind: "failed", error: result.error ?? `Auto resolver finished with status ${result.status}.` };
    } catch (err) {
      return { kind: "failed", error: `Auto resolver threw: ${getErrorMessage(err)}` };
    }
  }

  // -------------------------------------------------------------------------
  // Merge ladder (shipLane.md lines 194-195)
  // -------------------------------------------------------------------------

  type MergeLadderResult =
    | { kind: "merged" }
    | { kind: "conflict"; error: string }
    | { kind: "blocked"; error: string }
    | { kind: "failed"; error: string };

  /**
   * 1. Try the configured merge method via existing `prService.land()` (REST).
   * 2. On policy block, retry with `gh pr merge --admin`.
   * 3. On further failure, fall back to `gh pr merge --auto`.
   *
   * CRITICAL: never pass `--delete-branch` (shipLane.md line 212 — would
   * conflict with the project-root worktree on `main`). `prService.land()`
   * already deletes via `gh api -X DELETE`, so the cleanup path is
   * worktree-safe.
   */
  async function runMergeLadder(ctx: IterationContext): Promise<MergeLadderResult> {
    const { pr, pipelineSettings } = ctx;
    const method = resolveMergeMethod(pipelineSettings);

    logger.info("ptm.merge_ladder_start", { prId: pr.id, method });

    // Rung 1: REST merge via existing service (handles post-merge cleanup,
    // child-lane rebase, branch deletion via gh api -X DELETE).
    const restResult = await prService.land({ prId: pr.id, method, archiveLane: false });
    if (restResult.success) {
      return { kind: "merged" };
    }
    const restErr = restResult.error ?? "unknown REST merge error";
    logger.warn("ptm.merge_ladder_rest_failed", { prId: pr.id, error: restErr });

    // Conflict detection — short-circuit out so the caller can run the
    // conflict strategy and retry on the next iteration.
    if (/conflict|409/i.test(restErr)) {
      return { kind: "conflict", error: restErr };
    }

    // Look up the lane worktree for `gh` calls (gh resolves the PR from cwd).
    const lane = laneService.getLaneBaseAndBranch(pr.laneId);
    const ghMethodFlag = `--${method}`;
    const prNumberArg = String(pr.githubPrNumber);

    // Rung 2: gh pr merge --admin (overrides branch protection if the
    // operator has admin rights).
    const adminRes = await runGh(
      ["pr", "merge", prNumberArg, ghMethodFlag, "--admin"],
      { cwd: lane.worktreePath, timeoutMs: 90_000 },
    );
    if (adminRes.exitCode === 0) {
      logger.info("ptm.merge_ladder_admin_succeeded", { prId: pr.id });
      return { kind: "merged" };
    }
    logger.warn("ptm.merge_ladder_admin_failed", { prId: pr.id, stderr: adminRes.stderr.trim() });

    // Rung 3: gh pr merge --auto (queue the merge for when checks/policy
    // gates clear). This is a "park & wait" outcome, not an immediate land.
    const autoRes = await runGh(
      ["pr", "merge", prNumberArg, ghMethodFlag, "--auto"],
      { cwd: lane.worktreePath, timeoutMs: 60_000 },
    );
    if (autoRes.exitCode === 0) {
      logger.info("ptm.merge_ladder_auto_armed", { prId: pr.id });
      // Treat "auto-merge armed" as success-with-park: GitHub will land it
      // when conditions clear, no need to keep iterating.
      return { kind: "merged" };
    }

    return {
      kind: "blocked",
      error: `Merge ladder exhausted (REST: ${restErr}; admin: ${adminRes.stderr.trim() || adminRes.stdout.trim() || "exit " + adminRes.exitCode}; auto: ${autoRes.stderr.trim() || autoRes.stdout.trim() || "exit " + autoRes.exitCode})`,
    };
  }

  // -------------------------------------------------------------------------
  // Force-finalize predicate (shipLane.md lines 183-198)
  // -------------------------------------------------------------------------

  type ForceFinalizeDecision =
    | { kind: "skip"; reason: string }
    | { kind: "run"; ignoreReview: boolean; ignoreCi: boolean };

  function decideForceFinalize(
    ctx: IterationContext,
    checks: PrCheck[],
  ): ForceFinalizeDecision {
    const mode: ForceFinalizeMode = ctx.pipelineSettings.forceFinalizeMode;
    if (mode === "off") {
      return { kind: "skip", reason: "force-finalize disabled (off)" };
    }
    if (mode === "conditional") {
      const requireNoCi = ctx.pipelineSettings.forceFinalizeRequireNoCiFailures;
      const ciFailing = ctx.pr.checksStatus === "failing"
        || checks.some((c) => c.conclusion === "failure");
      if (requireNoCi && ciFailing) {
        return { kind: "skip", reason: "conditional force-finalize blocked (CI failing)" };
      }
    }
    // mode === "unconditional" or conditional-passed:
    //   - skip review-comment fixes (shipLane line 189)
    //   - only run CI fixes (line 190); if CI is already green, skip dispatch
    //     and go straight to merge ladder
    return { kind: "run", ignoreReview: true, ignoreCi: false };
  }

  // -------------------------------------------------------------------------
  // The iteration body
  // -------------------------------------------------------------------------

  async function runIteration(prId: string): Promise<void> {
    if (disposed) return;
    if (iterationInFlight.get(prId)) {
      logger.debug("ptm.iteration_skipped_in_flight", { prId });
      return;
    }
    iterationInFlight.set(prId, true);
    try {
      await runIterationInner(prId);
    } finally {
      iterationInFlight.set(prId, false);
    }
  }

  async function runIterationInner(prId: string): Promise<void> {
    const ctx = loadIterationContext(prId);
    if (!ctx) {
      logger.warn("ptm.iteration_aborted_pr_missing", { prId });
      return;
    }
    if (!ctx.runtime.autoConvergeEnabled) {
      logger.info("ptm.iteration_aborted_disabled", { prId });
      clearTimer(prId);
      return;
    }
    if (ctx.pr.state === "merged") {
      issueInventoryService.saveConvergenceRuntime(prId, {
        status: "merged",
        pollerStatus: "stopped",
        autoConvergeEnabled: false,
        errorMessage: null,
        pauseReason: null,
      });
      clearTimer(prId);
      return;
    }
    if (ctx.pr.state === "closed") {
      pauseLoop(prId, "PR is closed.");
      return;
    }

    issueInventoryService.saveConvergenceRuntime(prId, {
      status: "running",
      pollerStatus: "polling",
      lastPolledAt: nowIso(),
    });

    // Refresh remote state up-front so terminal-gate decisions use the
    // latest snapshot rather than whatever was cached.
    try {
      await prService.refresh({ prId });
    } catch (err) {
      logger.warn("ptm.refresh_failed", { prId, error: getErrorMessage(err) });
    }

    // Reload after refresh.
    const refreshed = loadIterationContext(prId);
    if (!refreshed) {
      pauseLoop(prId, "PR vanished after refresh.");
      return;
    }
    const fresh = refreshed;

    // ---- Step 1: base-advance conflict check (every iteration) ----
    const baseSync = await applyConflictStrategy(fresh, "base_advance");
    if (baseSync.kind === "paused") {
      pauseLoop(prId, baseSync.reason);
      return;
    }
    if (baseSync.kind === "failed") {
      pauseLoop(prId, "Base sync failed.", baseSync.error);
      return;
    }

    // ---- Step 2: early merge on green (shipLane intent) ----
    if (fresh.pipelineSettings.earlyMergeOnGreen) {
      const reviewClean = fresh.pr.reviewStatus !== "changes_requested" && fresh.pr.reviewStatus !== "requested";
      if (fresh.pr.checksStatus === "passing" && reviewClean) {
        const ladder = await runMergeLadder(fresh);
        if (ladder.kind === "merged") {
          issueInventoryService.saveConvergenceRuntime(prId, {
            status: "merged",
            pollerStatus: "stopped",
            autoConvergeEnabled: false,
            errorMessage: null,
            pauseReason: null,
          });
          clearTimer(prId);
          return;
        }
        if (ladder.kind === "conflict") {
          // Apply merge-time conflict strategy and retry on next wake.
          const conflictRes = await applyConflictStrategy(fresh, "merge_time");
          if (conflictRes.kind === "paused") return void pauseLoop(prId, conflictRes.reason);
          if (conflictRes.kind === "failed") return void pauseLoop(prId, "Merge-time conflict resolution failed.", conflictRes.error);
          schedule(prId, "justPushed");
          return;
        }
        if (ladder.kind === "blocked") {
          // Fall through to fix-dispatch — early merge isn't possible right now,
          // probably a missing required reviewer or status check we can't see.
          logger.info("ptm.early_merge_blocked_falling_through", { prId, error: ladder.error });
        } else if (ladder.kind === "failed") {
          pauseLoop(prId, "Early merge ladder failed.", ladder.error);
          return;
        }
      }
    }

    // ---- Step 3: terminal-gate check before dispatching fixes ----
    const gate = isTerminalForFixPush(fresh.pr);
    if (!gate.terminal) {
      logger.info("ptm.terminal_gate_pending", { prId, pendingSignal: gate.pendingSignal });
      issueInventoryService.saveConvergenceRuntime(prId, {
        pollerStatus: "waiting_for_checks",
        currentRound: fresh.runtime.currentRound,
      });
      schedule(prId, "warming");
      return;
    }

    // ---- Step 4: hard cap + force-finalize logic ----
    const maxRounds = fresh.pipelineSettings.maxRounds;
    const completedRounds = fresh.runtime.currentRound;
    const inProc = inProcessState.get(prId) ?? { forceFinalizeUsed: false, runArgs: { prId, scope: "both" as PrIssueResolutionScope } };

    let isForceFinalizeIteration = false;
    if (completedRounds >= maxRounds) {
      if (inProc.forceFinalizeUsed) {
        // Bonus iteration already consumed; nothing left to try.
        pauseLoop(prId, "Hard cap reached (force-finalize already attempted).");
        return;
      }
      // Need to fetch checks for the conditional predicate.
      let checks: PrCheck[] = [];
      try {
        checks = await prService.getChecks(prId);
      } catch (err) {
        logger.warn("ptm.force_finalize_checks_fetch_failed", { prId, error: getErrorMessage(err) });
      }
      const decision = decideForceFinalize(fresh, checks);
      if (decision.kind === "skip") {
        pauseLoop(prId, `Hard cap reached: ${decision.reason}`);
        return;
      }
      isForceFinalizeIteration = true;
      issueInventoryService.saveConvergenceRuntime(prId, {
        pauseReason: "force-finalize",
      });
    }

    // ---- Step 5: dispatch fix agent (or skip if force-finalize + green) ----
    const ciIsGreen = fresh.pr.checksStatus === "passing";
    const shouldSkipFixDispatch = isForceFinalizeIteration && ciIsGreen;

    if (!shouldSkipFixDispatch) {
      let scope: PrIssueResolutionScope;
      if (isForceFinalizeIteration) {
        // shipLane line 189: ignore review, only run CI fixes.
        scope = "checks";
      } else {
        scope = inProc.runArgs.scope ?? "both";
      }

      const modelId = inProc.runArgs.modelId?.trim() || deps.defaultModelId?.trim() || null;
      if (!modelId) {
        pauseLoop(prId, "No modelId available to dispatch fix agent.");
        return;
      }

      try {
        const launch = await launchPrIssueResolutionChat(
          {
            prService,
            laneService: {
              list: laneService.list,
              getLaneBaseAndBranch: laneService.getLaneBaseAndBranch,
            },
            agentChatService: {
              createSession: agentChatService.createSession,
              sendMessage: agentChatService.sendMessage,
              previewSessionToolNames: agentChatService.previewSessionToolNames,
            },
            sessionService,
            issueInventoryService,
          },
          {
            prId,
            scope,
            modelId,
            reasoning: inProc.runArgs.reasoning ?? deps.defaultReasoningEffort ?? null,
            additionalInstructions: inProc.runArgs.additionalInstructions ?? null,
          },
        );

        if (isForceFinalizeIteration) {
          inProc.forceFinalizeUsed = true;
        }
        inProcessState.set(prId, inProc);

        const status = issueInventoryService.getConvergenceStatus(prId);
        issueInventoryService.saveConvergenceRuntime(prId, {
          status: "running",
          pollerStatus: "waiting_for_comments",
          currentRound: status.currentRound,
          activeSessionId: launch.sessionId,
          activeLaneId: launch.laneId,
          activeHref: launch.href,
          pauseReason: isForceFinalizeIteration ? "force-finalize" : null,
          errorMessage: null,
        });

        // Wait for the agent to finish + push before re-evaluating.
        schedule(prId, "justPushed");
        return;
      } catch (err) {
        pauseLoop(prId, "Fix-agent dispatch failed.", getErrorMessage(err));
        return;
      }
    }

    // ---- Step 6: force-finalize green-path → straight to merge ladder ----
    if (isForceFinalizeIteration) {
      inProc.forceFinalizeUsed = true;
      inProcessState.set(prId, inProc);

      const ladder = await runMergeLadder(fresh);
      if (ladder.kind === "merged") {
        issueInventoryService.saveConvergenceRuntime(prId, {
          status: "merged",
          pollerStatus: "stopped",
          autoConvergeEnabled: false,
          errorMessage: null,
          pauseReason: "force-finalize",
        });
        clearTimer(prId);
        return;
      }
      if (ladder.kind === "conflict") {
        const conflictRes = await applyConflictStrategy(fresh, "merge_time");
        if (conflictRes.kind === "paused") return void pauseLoop(prId, conflictRes.reason);
        if (conflictRes.kind === "failed") return void pauseLoop(prId, "Force-finalize merge-time conflict resolution failed.", conflictRes.error);
        schedule(prId, "justPushed");
        return;
      }
      if (ladder.kind === "blocked") {
        failLoop(prId, `Force-finalize merge ladder blocked: ${ladder.error}`);
        return;
      }
      failLoop(prId, `Force-finalize merge ladder failed: ${ladder.error}`);
      return;
    }

    // Fallback: park waiting on review.
    schedule(prId, "waitingOnReview");
  }

  return {
    startPathToMerge,
    stopPathToMerge,
    resumeFromPersistedState,
    dispose,
  };
}
