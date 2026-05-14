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
 * Persistence happens through the existing `pr_convergence_state` runtime row
 * via `issueInventoryService`. The orchestrator runs ON TOP of the existing
 * manual entry points (`startPullRequestConvergenceRound`) and dispatches each
 * fix iteration via `launchPrIssueResolutionChat`.
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
import { createHash } from "node:crypto";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import { launchPrIssueResolutionChat } from "./prIssueResolver";
import { nowIso, getErrorMessage } from "../shared/utils";
import { defaultPrIssueResolutionScope, getPrIssueResolutionAvailability } from "../../../shared/prIssueResolution";
import type { createIssueInventoryService } from "./issueInventoryService";
import type { createPrService } from "./prService";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { createConflictService } from "../conflicts/conflictService";
import type { LaneWorktreeLockService } from "../lanes/laneWorktreeLockService";
import { LaneWorktreeLockedError } from "../lanes/laneWorktreeLockService";
import type {
  AtCapPolicy,
  AutoConflictAgentSettings,
  ConflictStrategy,
  ConvergenceRuntimeState,
  LaneWorktreeLockBlocker,
  MergeMethod,
  PathToMergeStartResult,
  PathToMergeStopResult,
  PipelineSettings,
  PrCheck,
  PrComment,
  PrIssueResolutionScope,
  PrAgentPermissionMode,
  PrReview,
  PrReviewThread,
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
    "createSession" | "sendMessage" | "previewSessionToolNames" | "interrupt" | "getSessionSummary"
  >;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  issueInventoryService: ReturnType<typeof createIssueInventoryService>;
  conflictService: Pick<ReturnType<typeof createConflictService>, "runExternalResolver">;
  laneWorktreeLockService: LaneWorktreeLockService;
  defaultModelId: string | null;
  defaultReasoningEffort: string | null;
};

export type StartPathToMergeArgs = {
  prId: string;
  /** Optional override for the agent model used for fix dispatches. */
  modelId?: string | null;
  /** Optional override for reasoning effort passed to the fix agent. */
  reasoning?: string | null;
  /** Optional permission preset passed to the fix agent. */
  permissionMode?: PrAgentPermissionMode | null;
  /** Scope passed to `launchPrIssueResolutionChat` per iteration. */
  scope?: PrIssueResolutionScope;
  /** Optional extra instructions appended to each iteration prompt. */
  additionalInstructions?: string | null;
};

export type StartPathToMergeResult = PathToMergeStartResult;

export type StopPathToMergeResult = PathToMergeStopResult;

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

/**
 * Mutable per-PR scratchpad the orchestrator carries between iterations.
 * Persistence is intentionally minimal — these counters reset on restart so
 * the at-cap policy errs on the side of doing one extra retry rather than
 * silently giving up.
 *
 * Exported for unit testing of {@link decideAtCapAction}.
 */
export type InProcessState = {
  forceFinalizeUsed: boolean;
  runArgs: StartPathToMergeArgs;
  /** When the wait_for_ci timer started; null until we enter that path. */
  waitForCiStartedAt: string | null;
  /** Bonus iterations consumed under ci_retry_once / ci_retry_loop. */
  ciRetryAttemptsUsed: number;
  /** Consecutive missing/error summaries observed for the same active session. */
  sessionMissingPolls: number;
  /** Session id the missing-summary counter currently applies to. */
  sessionMissingSessionId: string | null;
  /** PR head SHA captured when the last fix agent was dispatched. */
  lastDispatchHeadSha: string | null;
  /** PR head SHA for which post-push review-bot pings were already sent. */
  lastBotPingHeadSha: string | null;
  /** Timestamp for the last post-push review-bot ping. */
  lastBotPingAt: string | null;
  /** Durable lane/worktree lock token held by this PtM run. */
  laneWorktreeLockToken: string | null;
};

export function makeInProcessState(runArgs: StartPathToMergeArgs): InProcessState {
  return {
    forceFinalizeUsed: false,
    runArgs,
    waitForCiStartedAt: null,
    ciRetryAttemptsUsed: 0,
    sessionMissingPolls: 0,
    sessionMissingSessionId: null,
    lastDispatchHeadSha: null,
    lastBotPingHeadSha: null,
    lastBotPingAt: null,
    laneWorktreeLockToken: null,
  };
}

function makeInProcessStateFromRuntime(
  runArgs: StartPathToMergeArgs,
  runtime: ConvergenceRuntimeState,
): InProcessState {
  return {
    ...makeInProcessState(runArgs),
    forceFinalizeUsed: runtime.forceFinalizeUsed,
    waitForCiStartedAt: runtime.waitForCiStartedAt,
    ciRetryAttemptsUsed: runtime.ciRetryAttemptsUsed,
    lastDispatchHeadSha: runtime.lastDispatchHeadSha,
    lastBotPingHeadSha: runtime.lastBotPingHeadSha,
    lastBotPingAt: runtime.lastBotPingAt,
    laneWorktreeLockToken: null,
  };
}

function hashPauseReason(reason: string): string {
  return createHash("sha256").update(reason).digest("hex");
}

/**
 * What {@link decideAtCapAction} returned for the current iteration.
 *   - `stop`        : pause the loop, no more action.
 *   - `wait`        : reschedule a poll; CI hasn't settled yet.
 *   - `merge_now`   : skip fix dispatch; run the merge ladder right away.
 *   - `dispatch_ci` : run one bonus CI-only fix iteration, then re-enter.
 */
export type AtCapDecision =
  | { kind: "stop"; reason: string }
  | { kind: "wait"; phase: PhaseDelayKind; reason: string }
  | { kind: "merge_now"; reason: string }
  | { kind: "dispatch_ci"; reason: string };

/**
 * Decide what the convergence loop should do when it has consumed
 * `pipelineSettings.maxRounds` iterations without converging.
 *
 * Pure with respect to its inputs, except that it mutates `inProc` to bump
 * counters / stamp timestamps used by subsequent calls.
 */
export function decideAtCapAction(
  ctx: IterationContext,
  checks: PrCheck[],
  inProc: InProcessState,
  now: () => number = Date.now,
): AtCapDecision {
  const policy = ctx.pipelineSettings.atCapPolicy;
  const ciFailing =
    ctx.pr.checksStatus === "failing" || checks.some((c) => c.conclusion === "failure");
  const ciPending = !ciFailing && ctx.pr.checksStatus !== "passing";
  const ciPassing = ctx.pr.checksStatus === "passing" && !ciFailing;
  const clearCiWait = () => {
    inProc.waitForCiStartedAt = null;
  };
  const waitForCiOrStop = (policy: Extract<AtCapPolicy, "wait_for_ci" | "ci_retry_once" | "ci_retry_loop">, reason: string): AtCapDecision => {
    if (!inProc.waitForCiStartedAt) {
      inProc.waitForCiStartedAt = new Date(now()).toISOString();
    }
    const elapsedMs = now() - new Date(inProc.waitForCiStartedAt).getTime();
    const timeoutMs = Math.max(1, ctx.pipelineSettings.atCapWaitMinutes) * 60_000;
    if (elapsedMs > timeoutMs) {
      return { kind: "stop", reason: `${policy}: timed out waiting for CI to settle.` };
    }
    return { kind: "wait", phase: "warming", reason };
  };

  switch (policy) {
    case "stop":
      return { kind: "stop", reason: "Iteration cap reached (policy: stop)." };

    case "wait_for_ci": {
      if (ciPassing) {
        clearCiWait();
        return { kind: "merge_now", reason: "wait_for_ci: CI is green, attempting merge." };
      }
      if (ciFailing) {
        clearCiWait();
        return { kind: "stop", reason: "wait_for_ci: CI is failing; not auto-merging." };
      }
      return waitForCiOrStop("wait_for_ci", "wait_for_ci: CI still pending.");
    }

    case "ci_retry_once": {
      if (ciPassing) {
        clearCiWait();
        return { kind: "merge_now", reason: "ci_retry_once: CI already green." };
      }
      if (inProc.ciRetryAttemptsUsed >= 1) {
        clearCiWait();
        return { kind: "stop", reason: "ci_retry_once: bonus iteration didn't make CI green." };
      }
      if (ciPending) {
        return waitForCiOrStop("ci_retry_once", "ci_retry_once: waiting for CI to finish before retry.");
      }
      clearCiWait();
      inProc.ciRetryAttemptsUsed = 1;
      return { kind: "dispatch_ci", reason: "ci_retry_once: dispatching bonus CI-only iteration." };
    }

    case "ci_retry_loop": {
      if (ciPassing) {
        clearCiWait();
        return { kind: "merge_now", reason: "ci_retry_loop: CI is green, attempting merge." };
      }
      const max = Math.max(1, ctx.pipelineSettings.atCapCiRetryMax);
      if (inProc.ciRetryAttemptsUsed >= max) {
        clearCiWait();
        return { kind: "stop", reason: `ci_retry_loop: ${max} bonus iterations exhausted.` };
      }
      if (ciPending) {
        return waitForCiOrStop("ci_retry_loop", "ci_retry_loop: waiting for CI to settle before next retry.");
      }
      clearCiWait();
      inProc.ciRetryAttemptsUsed += 1;
      return {
        kind: "dispatch_ci",
        reason: `ci_retry_loop: dispatching bonus CI iteration ${inProc.ciRetryAttemptsUsed}/${max}.`,
      };
    }

    case "force_merge":
      return { kind: "merge_now", reason: "force_merge: bypassing CI and review." };
  }
}

function resolveMergeMethod(settings: PipelineSettings): MergeMethod {
  // `repo_default` has no in-process source-of-truth for the repo's default
  // merge method — the GitHub merge REST API requires an explicit
  // merge_method, so we fall back to `squash` (matches shipLane's default).
  if (settings.mergeMethod === "repo_default") return "squash";
  return settings.mergeMethod;
}

const REVIEW_BOT_WAIT_TIMEOUT_MS = 5 * 60_000;
const REVIEW_BOT_CHECKS = [
  { name: "Greptile", pattern: /\bgreptile\b/i },
  { name: "CodeRabbit", pattern: /\bcoderabbit\b|code\s*rabbit/i },
] as const;

function hasCopilotResponse(comments: PrComment[], reviews: PrReview[]): boolean {
  const isCopilotAuthor = (author: string | null | undefined) => {
    const normalized = author?.trim().toLowerCase();
    return normalized === "copilot-pull-request-reviewer[bot]"
      || normalized === "github-copilot[bot]"
      || normalized === "copilot[bot]";
  };
  return comments.some((comment) => isCopilotAuthor(comment.author))
    || reviews.some((review) => isCopilotAuthor(review.reviewer));
}

function isWithinReviewBotWaitWindow(timestamp: string | null | undefined, now: () => number): boolean {
  if (!timestamp) return false;
  const startedAt = Date.parse(timestamp);
  return Number.isFinite(startedAt) && now() - startedAt < REVIEW_BOT_WAIT_TIMEOUT_MS;
}

function getPendingReviewBots(
  checks: PrCheck[],
  comments: PrComment[],
  reviews: PrReview[],
  inProc: InProcessState,
  now: () => number = Date.now,
): string[] {
  const pending = new Set<string>();
  for (const bot of REVIEW_BOT_CHECKS) {
    const matchingChecks = checks.filter((check) => bot.pattern.test(check.name));
    if (matchingChecks.some((check) => check.status !== "completed"
      && isWithinReviewBotWaitWindow(inProc.lastBotPingAt ?? check.startedAt, now))) {
      pending.add(bot.name);
    }
  }

  if (inProc.lastBotPingAt && !hasCopilotResponse(comments, reviews)) {
    const pingedAt = Date.parse(inProc.lastBotPingAt);
    if (Number.isFinite(pingedAt) && now() - pingedAt < REVIEW_BOT_WAIT_TIMEOUT_MS) {
      pending.add("Copilot");
    }
  }

  return [...pending];
}

function looksLikeBranchPolicyBlock(error: string): boolean {
  return /base branch policy|branch protection|protected branch|required status|required check|required review|review is required|review required|code owner|codeowner/i.test(error);
}

export function shouldAttemptAdminMergeForRestError(
  error: string,
  opts: { allowForceMerge?: boolean; ignoreReview?: boolean } = {},
): boolean {
  if (!looksLikeBranchPolicyBlock(error)) return false;
  if (opts.allowForceMerge) return true;
  return !opts.ignoreReview;
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
  const {
    logger,
    issueInventoryService,
    prService,
    laneService,
    agentChatService,
    sessionService,
    conflictService,
    laneWorktreeLockService,
  } = deps;

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
  const inProcessState = new Map<string, InProcessState>();
  const makeInProcess = makeInProcessState;

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

  function heartbeatLoopLock(prId: string): void {
    const token = inProcessState.get(prId)?.laneWorktreeLockToken?.trim() ?? "";
    if (!token) return;
    try {
      const lock = laneWorktreeLockService.heartbeat(token);
      if (!lock) {
        logger.warn("ptm.lock_heartbeat_missing", { prId });
      }
    } catch (err) {
      logger.warn("ptm.lock_heartbeat_failed", { prId, error: getErrorMessage(err) });
    }
  }

  function schedule(prId: string, kind: PhaseDelayKind): void {
    if (disposed) return;
    clearTimer(prId);
    heartbeatLoopLock(prId);
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

  function releaseLoopLock(prId: string): void {
    const inProc = inProcessState.get(prId) ?? null;
    inProcessState.delete(prId);
    releasePtmLock(prId, inProc?.laneWorktreeLockToken ?? null);
  }

  function blockStartOnLock(prId: string, blocker: LaneWorktreeLockBlocker): StartPathToMergeResult {
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

  function ensurePtmLockForIteration(pr: PrSummary, inProc: InProcessState): LaneWorktreeLockBlocker | null {
    try {
      const acquired = acquirePtmLock(pr, inProc.laneWorktreeLockToken);
      inProc.laneWorktreeLockToken = acquired.token;
      inProcessState.set(pr.id, inProc);
      return null;
    } catch (err) {
      if (err instanceof LaneWorktreeLockedError) return err.blocker;
      throw err;
    }
  }

  async function resolveDispatchScope(
    prId: string,
    requestedScope: PrIssueResolutionScope,
    options: { allowFallback: boolean } = { allowFallback: true },
  ): Promise<PrIssueResolutionScope | null> {
    const [checks, reviewThreads, comments] = await Promise.all([
      prService.getChecks(prId),
      prService.getReviewThreads(prId),
      prService.getComments(prId).catch(() => []),
    ]);
    const availability = getPrIssueResolutionAvailability(checks, reviewThreads, comments);
    if (requestedScope === "both") {
      return defaultPrIssueResolutionScope(availability);
    }
    if (requestedScope === "checks") {
      if (availability.hasActionableChecks) return "checks";
      return options.allowFallback ? defaultPrIssueResolutionScope(availability) : null;
    }
    if (requestedScope === "comments") {
      if (availability.hasActionableComments) return "comments";
      return options.allowFallback ? defaultPrIssueResolutionScope(availability) : null;
    }
    return defaultPrIssueResolutionScope(availability);
  }

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  async function startPathToMerge(args: StartPathToMergeArgs): Promise<StartPathToMergeResult> {
    const prId = args.prId.trim();
    if (!prId) throw new Error("prId is required");

    const inProc = makeInProcess(args);
    const pr = prService.listAll().find((entry) => entry.id === prId) ?? null;
    if (pr) {
      try {
        inProc.laneWorktreeLockToken = acquirePtmLock(pr).token;
      } catch (err) {
        if (err instanceof LaneWorktreeLockedError) {
          logger.info("ptm.start_blocked_by_lane_lock", { prId, blocker: err.blocker.message });
          return blockStartOnLock(prId, err.blocker);
        }
        throw err;
      }
    }

    inProcessState.set(prId, inProc);

    // Persist run args before saving the launch runtime. The runtime exposes a
    // derived `pathToMergeActive` flag from this blob so renderers can avoid
    // starting their legacy auto-converge poller for main-owned PtM work.
    issueInventoryService.savePathToMergeArgs(prId, {
      modelId: args.modelId ?? null,
      reasoning: args.reasoning ?? null,
      permissionMode: args.permissionMode ?? null,
      scope: args.scope ?? "both",
      additionalInstructions: args.additionalInstructions ?? null,
    });

    const runtime = issueInventoryService.saveConvergenceRuntime(prId, {
      autoConvergeEnabled: true,
      status: "launching",
      pollerStatus: "scheduled",
      pauseReason: null,
      errorMessage: null,
      forceFinalizeUsed: false,
      ciRetryAttemptsUsed: 0,
      waitForCiStartedAt: null,
      lastDispatchHeadSha: null,
      pauseRepeatCount: 0,
      lastPauseReasonHash: null,
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
    const inProc = inProcessState.get(prId) ?? null;
    inProcessState.delete(prId);

    const current = issueInventoryService.getConvergenceRuntime(prId);
    const activeSessionId = current.activeSessionId;
    if (activeSessionId) {
      try {
        await agentChatService.interrupt({ sessionId: activeSessionId });
      } catch (err) {
        logger.warn("ptm.interrupt_failed", { prId, sessionId: activeSessionId, error: getErrorMessage(err) });
      }
      issueInventoryService.resetSentToAgent(prId, { sessionId: activeSessionId });
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
      waitForCiStartedAt: null,
      lastDispatchHeadSha: null,
      lastStoppedAt: nowIso(),
    });
    releasePtmLock(prId, inProc?.laneWorktreeLockToken ?? null);

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
      // Rehydrate the original startPathToMerge args (modelId, reasoning,
      // scope, additionalInstructions) from the side-channel column.
      const persistedArgs = issueInventoryService.getPathToMergeArgs(pr.id);
      const persistedModelId = typeof persistedArgs?.modelId === "string" ? persistedArgs.modelId.trim() : "";
      // Stale-flag recovery: in older builds the renderer could persist
      // `autoConvergeEnabled: true` without ever calling pathToMergeStart, so
      // resume would wake an empty loop that could only ever fail with
      // "No modelId available". Treat that case as a stale flag — clear it
      // instead of warming a doomed wake-up.
      if (!persistedModelId && !deps.defaultModelId?.trim()) {
        logger.info("ptm.resume_clearing_stale_flag", { prId: pr.id });
        issueInventoryService.saveConvergenceRuntime(pr.id, {
          autoConvergeEnabled: false,
          pollerStatus: "stopped",
          pauseReason: null,
          errorMessage: null,
          lastStoppedAt: nowIso(),
        });
        issueInventoryService.savePathToMergeArgs(pr.id, null);
        continue;
      }
      const runArgs: StartPathToMergeArgs = {
        prId: pr.id,
        modelId: persistedModelId || null,
        reasoning: typeof persistedArgs?.reasoning === "string" ? persistedArgs.reasoning : null,
        permissionMode: typeof persistedArgs?.permissionMode === "string"
          ? persistedArgs.permissionMode as PrAgentPermissionMode
          : null,
        scope: (persistedArgs?.scope as PrIssueResolutionScope | undefined) ?? "both",
        additionalInstructions: typeof persistedArgs?.additionalInstructions === "string"
          ? persistedArgs.additionalInstructions
          : null,
      };
      const inProc = makeInProcessStateFromRuntime(runArgs, runtime);
      const blocker = ensurePtmLockForIteration(pr, inProc);
      if (blocker) {
        logger.info("ptm.resume_blocked_by_lane_lock", { prId: pr.id, blocker: blocker.message });
        blockStartOnLock(pr.id, blocker);
        continue;
      }
      inProcessState.set(pr.id, inProc);
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

  function loadIterationContext(prId: string): IterationContext | null {
    const pr = prService.listAll().find((entry) => entry.id === prId) ?? null;
    if (!pr) return null;
    const pipelineSettings = issueInventoryService.getPipelineSettings(prId);
    const runtime = issueInventoryService.getConvergenceRuntime(prId);
    return { pr, pipelineSettings, runtime };
  }

  function persistInProcessState(prId: string, inProc: InProcessState): void {
    inProcessState.set(prId, inProc);
    issueInventoryService.saveConvergenceRuntime(prId, {
      forceFinalizeUsed: inProc.forceFinalizeUsed,
      ciRetryAttemptsUsed: inProc.ciRetryAttemptsUsed,
      waitForCiStartedAt: inProc.waitForCiStartedAt,
      lastDispatchHeadSha: inProc.lastDispatchHeadSha,
      lastBotPingHeadSha: inProc.lastBotPingHeadSha,
      lastBotPingAt: inProc.lastBotPingAt,
    });
  }

  function isAutoConvergeStillEnabled(prId: string): boolean {
    return issueInventoryService.getConvergenceRuntime(prId).autoConvergeEnabled;
  }

  async function readCurrentHeadSha(prId: string): Promise<string | null> {
    try {
      const commits = await prService.getCommits(prId);
      return commits.at(-1)?.sha?.trim() || null;
    } catch (err) {
      logger.debug("ptm.head_sha_lookup_failed", { prId, error: getErrorMessage(err) });
      return null;
    }
  }

  async function postReviewBotPings(ctx: IterationContext, inProc: InProcessState, headSha: string | null): Promise<void> {
    const normalizedHeadSha = headSha?.trim() || null;
    if (!normalizedHeadSha) return;
    if (inProc.lastBotPingHeadSha === normalizedHeadSha) return;

    const bodies = ["@copilot review but do not make fixes"];
    let changedFileCount = 0;
    try {
      changedFileCount = (await prService.getFiles(ctx.pr.id)).length;
    } catch (err) {
      logger.debug("ptm.bot_ping_file_count_failed", { prId: ctx.pr.id, error: getErrorMessage(err) });
    }
    if (changedFileCount > 250) {
      bodies.push("@greptile review", "@coderabbit review");
    }

    const copilotBody = bodies[0]!;
    const secondaryBodies = bodies.slice(1);
    let postedCount = 0;
    try {
      await prService.addComment({ prId: ctx.pr.id, body: copilotBody });
      postedCount += 1;
    } catch (err) {
      logger.warn("ptm.bot_ping_failed", { prId: ctx.pr.id, body: copilotBody, error: getErrorMessage(err) });
      logger.warn("ptm.bot_pings_not_recorded", { prId: ctx.pr.id, headSha: normalizedHeadSha, postedCount });
      return;
    }

    for (const body of secondaryBodies) {
      try {
        await prService.addComment({ prId: ctx.pr.id, body });
        postedCount += 1;
      } catch (err) {
        logger.warn("ptm.bot_ping_failed", { prId: ctx.pr.id, body, error: getErrorMessage(err) });
      }
    }

    inProc.lastBotPingHeadSha = normalizedHeadSha;
    inProc.lastBotPingAt = nowIso();
    persistInProcessState(ctx.pr.id, inProc);
    logger.info("ptm.bot_pings_posted", { prId: ctx.pr.id, headSha: normalizedHeadSha, count: postedCount });
  }

  function pauseLoop(prId: string, reason: string, errorMessage?: string | null): ConvergenceRuntimeState {
    clearTimer(prId);
    releaseLoopLock(prId);
    const current = issueInventoryService.getConvergenceRuntime(prId);
    const reasonHash = hashPauseReason(reason);
    const pauseRepeatCount = current.lastPauseReasonHash === reasonHash
      ? current.pauseRepeatCount + 1
      : 1;
    return issueInventoryService.saveConvergenceRuntime(prId, {
      status: "paused",
      pollerStatus: "paused",
      pauseReason: reason,
      errorMessage: errorMessage ?? null,
      pauseRepeatCount,
      lastPauseReasonHash: reasonHash,
      lastPausedAt: nowIso(),
      autoConvergeEnabled: false,
    });
  }

  function failLoop(prId: string, errorMessage: string): ConvergenceRuntimeState {
    clearTimer(prId);
    releaseLoopLock(prId);
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
    let cwd: string;
    try {
      cwd = laneService.getLaneBaseAndBranch(pr.laneId).worktreePath;
    } catch (err) {
      // Lane row was deleted out from under us (operator action, archive, etc.).
      // Surface a clean pause instead of letting the throw silently kill the loop.
      return { kind: "paused", reason: `Lane ${pr.laneId} unavailable: ${getErrorMessage(err)}` };
    }
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
        laneWorktreeLockToken: inProcessState.get(pr.id)?.laneWorktreeLockToken ?? null,
      } as Parameters<typeof conflictService.runExternalResolver>[0] & { laneWorktreeLockToken?: string | null });
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
    | { kind: "merged"; via: "rest" | "admin" }
    /** `gh pr merge --auto` armed GitHub auto-merge — the PR is NOT yet landed. */
    | { kind: "auto_armed" }
    | { kind: "conflict"; error: string }
    | { kind: "blocked"; error: string }
    | { kind: "failed"; error: string };

  function hasActionableReviewThread(thread: PrReviewThread): boolean {
    return !thread.isResolved && !thread.isOutdated;
  }

  function hasBlockingCommentedReview(review: PrReview): boolean {
    return review.state === "commented" && Boolean(review.body?.trim());
  }

  function isPermanentCleanInventoryBlocker(ctx: IterationContext, error: string): boolean {
    if (ctx.pr.checksStatus !== "passing") return true;
    return /\bCI\b|no completed successful CI checks|no CI checks/i.test(error);
  }

  function latestReviewByReviewer(reviews: PrReview[]): PrReview[] {
    const latestByReviewer = new Map<string, PrReview>();
    const anonymousReviews: PrReview[] = [];
    for (const review of reviews) {
      const reviewer = review.reviewer.trim().toLowerCase();
      if (!reviewer) {
        anonymousReviews.push(review);
        continue;
      }
      const current = latestByReviewer.get(reviewer);
      const currentAt = current?.submittedAt ? Date.parse(current.submittedAt) : Number.NEGATIVE_INFINITY;
      const nextAt = review.submittedAt ? Date.parse(review.submittedAt) : Number.NEGATIVE_INFINITY;
      if (!current || nextAt >= currentAt) {
        latestByReviewer.set(reviewer, review);
      }
    }
    return [...latestByReviewer.values(), ...anonymousReviews];
  }

  async function getMergeReadinessBlocker(
    ctx: IterationContext,
    opts: { allowForceMerge?: boolean; ignoreReview?: boolean } = {},
  ): Promise<string | null> {
    if (opts.allowForceMerge) return null;

    if (ctx.pr.checksStatus !== "passing") {
      return `Auto-merge blocked because CI is ${ctx.pr.checksStatus}.`;
    }
    if (!opts.ignoreReview) {
      if (ctx.pr.reviewStatus === "changes_requested") {
        return "Auto-merge blocked because a review requested changes.";
      }
      if (ctx.pr.reviewStatus === "requested") {
        return "Auto-merge blocked because a requested review is still pending.";
      }
    }

    try {
      const checks = await prService.getChecks(ctx.pr.id);

      if (checks.length === 0) {
        return "Auto-merge blocked because no CI checks were found on the PR head.";
      }
      const failingChecks = checks.filter((check) =>
        check.conclusion === "failure" ||
        check.conclusion === "cancelled",
      );
      if (failingChecks.length > 0) {
        return `Auto-merge blocked because ${failingChecks.length} CI check${failingChecks.length === 1 ? "" : "s"} failed.`;
      }
      const pendingChecks = checks.filter((check) => check.status !== "completed");
      if (pendingChecks.length > 0) {
        const verb = pendingChecks.length === 1 ? "is" : "are";
        return `Auto-merge blocked because ${pendingChecks.length} CI check${pendingChecks.length === 1 ? "" : "s"} ${verb} still running.`;
      }
      const passingChecks = checks.filter((check) =>
        check.status === "completed" &&
        (check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped"),
      );
      if (passingChecks.length === 0) {
        return "Auto-merge blocked because no completed successful CI checks were found.";
      }

      if (!opts.ignoreReview) {
        const [reviewThreads, reviews] = await Promise.all([
          prService.getReviewThreads(ctx.pr.id),
          prService.getReviews(ctx.pr.id),
        ]);
        const unresolvedThreads = reviewThreads.filter(hasActionableReviewThread);
        if (unresolvedThreads.length > 0) {
          return `Auto-merge blocked because ${unresolvedThreads.length} review thread${unresolvedThreads.length === 1 ? "" : "s"} are unresolved.`;
        }
        const latestReviews = latestReviewByReviewer(reviews);
        if (latestReviews.some((review) => review.state === "changes_requested")) {
          return "Auto-merge blocked because a review requested changes.";
        }
        const commentedReviews = latestReviews.filter(hasBlockingCommentedReview);
        if (commentedReviews.length > 0) {
          const reviewers = Array.from(new Set(commentedReviews.map((review) => review.reviewer).filter(Boolean))).slice(0, 3);
          const suffix = reviewers.length ? ` (${reviewers.join(", ")})` : "";
          return `Auto-merge blocked because ${commentedReviews.length} commented review${commentedReviews.length === 1 ? "" : "s"} still need operator review${suffix}.`;
        }
      }
    } catch (err) {
      return `Auto-merge blocked because merge readiness could not be verified: ${getErrorMessage(err)}`;
    }

    return null;
  }

  /**
   * 1. Try the configured merge method via existing `prService.land()` (REST).
   * 2. On policy block, retry with `gh pr merge --admin`.
   * 3. On further failure, fall back to `gh pr merge --auto` (when the
   *    pipeline's auto-merge toggle is on).
   *
   * CRITICAL: never pass `--delete-branch` to gh (shipLane.md line 212 —
   * would conflict with the project-root worktree on `main`). For rungs 2/3
   * we run `prService.runPostMergeCleanup` after success so branch deletion,
   * child-lane rebase advance, and cache refresh all still happen.
   */
  async function runMergeLadder(
    ctx: IterationContext,
    opts: { allowForceMerge?: boolean; ignoreReview?: boolean } = {},
  ): Promise<MergeLadderResult> {
    const { pr, pipelineSettings } = ctx;
    const method = resolveMergeMethod(pipelineSettings);
    const readinessBlocker = await getMergeReadinessBlocker(ctx, opts);
    if (readinessBlocker) {
      logger.warn("ptm.merge_ladder_blocked_readiness", { prId: pr.id, reason: readinessBlocker });
      return { kind: "blocked", error: readinessBlocker };
    }

    logger.info("ptm.merge_ladder_start", { prId: pr.id, method });

    // Rung 1: REST merge via existing service (handles post-merge cleanup,
    // child-lane rebase, branch deletion via gh api -X DELETE).
    const restResult = await prService.land({ prId: pr.id, method, archiveLane: false });
    if (restResult.success) {
      return { kind: "merged", via: "rest" };
    }
    const restErr = restResult.error ?? "unknown REST merge error";
    logger.warn("ptm.merge_ladder_rest_failed", { prId: pr.id, error: restErr });

    // Conflict detection — short-circuit out so the caller can run the
    // conflict strategy and retry on the next iteration.
    if (/conflict|409/i.test(restErr)) {
      return { kind: "conflict", error: restErr };
    }

    // Look up the lane worktree for `gh` calls (gh resolves the PR from cwd).
    let laneWorktreePath: string;
    try {
      laneWorktreePath = laneService.getLaneBaseAndBranch(pr.laneId).worktreePath;
    } catch (err) {
      return { kind: "failed", error: `Lane lookup failed for merge ladder: ${getErrorMessage(err)}` };
    }
    const ghMethodFlag = `--${method}`;
    const prNumberArg = String(pr.githubPrNumber);

    // Rung 2: gh pr merge --admin. Per shipLane, only try this for branch
    // policy/protection blocks; using admin for arbitrary API failures can
    // accidentally bypass real red signals.
    let adminError = "admin merge skipped because REST failure was not a branch-policy block";
    if (shouldAttemptAdminMergeForRestError(restErr, opts)) {
      const adminRes = await runGh(
        ["pr", "merge", prNumberArg, ghMethodFlag, "--admin"],
        { cwd: laneWorktreePath, timeoutMs: 90_000 },
      );
      if (adminRes.exitCode === 0) {
        logger.info("ptm.merge_ladder_admin_succeeded", { prId: pr.id });
        // gh CLI doesn't run our cleanup pipeline — invoke it explicitly so the
        // remote branch is deleted, child lanes advance, group memberships are
        // cleared, and caches refresh. Any cleanup error is logged inside the
        // helper and never masks the successful merge.
        try {
          await prService.runPostMergeCleanup({ prId: pr.id, mergeCommitSha: null, archiveLane: false });
        } catch (err) {
          logger.warn("ptm.merge_ladder_admin_cleanup_failed", { prId: pr.id, error: getErrorMessage(err) });
        }
        return { kind: "merged", via: "admin" };
      }
      adminError = adminRes.stderr.trim() || adminRes.stdout.trim() || `exit ${adminRes.exitCode}`;
      logger.warn("ptm.merge_ladder_admin_failed", { prId: pr.id, stderr: adminRes.stderr.trim() });
    } else if (looksLikeBranchPolicyBlock(restErr)) {
      adminError = opts.ignoreReview && !opts.allowForceMerge
        ? "admin merge skipped because review policy was intentionally left for GitHub to enforce"
        : "admin merge skipped because force merge is not allowed";
      logger.info("ptm.merge_ladder_admin_skipped", { prId: pr.id, restErr, reason: adminError });
    } else {
      logger.info("ptm.merge_ladder_admin_skipped", { prId: pr.id, restErr });
    }

    // Rung 3: gh pr merge --auto (queue the merge for when checks/policy
    // gates clear). This is a "park & wait" outcome, not an immediate land.
    // Only attempt it when the user explicitly opted into auto-merge.
    if (!pipelineSettings.autoMerge) {
      return {
        kind: "blocked",
        error: `Merge ladder exhausted (REST: ${restErr}; admin: ${adminError}). auto-merge skipped because pipelineSettings.autoMerge is false.`,
      };
    }
    const autoRes = await runGh(
      ["pr", "merge", prNumberArg, ghMethodFlag, "--auto"],
      { cwd: laneWorktreePath, timeoutMs: 60_000 },
    );
    if (autoRes.exitCode === 0) {
      logger.info("ptm.merge_ladder_auto_armed", { prId: pr.id });
      // DO NOT run post-merge cleanup here — the PR has not actually merged
      // yet. The caller parks the loop and re-polls pr.state until GitHub
      // either lands the auto-merge (then cleanup runs on observation) or it
      // times out/fails (then we surface that to the user).
      return { kind: "auto_armed" };
    }

    return {
      kind: "blocked",
      error: `Merge ladder exhausted (REST: ${restErr}; admin: ${adminError}; auto: ${autoRes.stderr.trim() || autoRes.stdout.trim() || "exit " + autoRes.exitCode})`,
    };
  }

  // decideAtCapAction is exported at module scope (above) for testability.

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
      releaseLoopLock(prId);
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

    const inProc = inProcessState.get(prId)
      ?? makeInProcessStateFromRuntime({ prId, scope: "both" as PrIssueResolutionScope }, ctx.runtime);
    const lockBlocker = ensurePtmLockForIteration(ctx.pr, inProc);
    if (lockBlocker) {
      clearTimer(prId);
      issueInventoryService.saveConvergenceRuntime(prId, {
        autoConvergeEnabled: false,
        status: "paused",
        pollerStatus: "paused",
        pauseReason: lockBlocker.message,
        errorMessage: null,
        lastPausedAt: nowIso(),
      });
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
    if (!isAutoConvergeStillEnabled(prId)) {
      clearTimer(prId);
      return;
    }

    // Reload after refresh.
    const refreshed = loadIterationContext(prId);
    if (!refreshed) {
      pauseLoop(prId, "PR vanished after refresh.");
      return;
    }
    const fresh = refreshed;

    // Keep issue inventory fresh even when Path to Merge is started from the
    // CLI or a queue flow instead of an already-open PR detail tab. Without
    // this, a red PR with stale/empty inventory can look "clean" and park
    // before the fix agent ever sees the failing check.
    let latestChecks: PrCheck[] = [];
    let latestComments: PrComment[] = [];
    let latestReviews: PrReview[] = [];
    try {
      const [checks, reviewThreads, comments, reviews] = await Promise.all([
        prService.getChecks(prId),
        prService.getReviewThreads(prId),
        (prService.getComments?.(prId) ?? Promise.resolve([] as PrComment[])).catch(() => [] as PrComment[]),
        prService.getReviews(prId).catch(() => [] as PrReview[]),
      ]);
      latestChecks = checks;
      latestComments = comments;
      latestReviews = reviews;
      issueInventoryService.syncFromPrData(prId, checks, reviewThreads, comments);
    } catch (err) {
      logger.warn("ptm.inventory_sync_failed", { prId, error: getErrorMessage(err) });
    }
    if (!isAutoConvergeStillEnabled(prId)) {
      clearTimer(prId);
      return;
    }

    // Re-check merged state in case a previously armed `gh pr merge --auto`
    // landed between iterations. If so, complete the cleanup now and exit.
    if (fresh.pr.state === "merged") {
      try {
        await prService.runPostMergeCleanup({ prId, mergeCommitSha: null, archiveLane: false });
      } catch (err) {
        logger.warn("ptm.post_merge_cleanup_on_observation_failed", { prId, error: getErrorMessage(err) });
      }
      releaseLoopLock(prId);
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

    // Look up `behindBaseBy` once via the status snapshot; skip the base-sync
    // round-trip when the PR is already at base — otherwise every wake fires
    // a redundant `git fetch` + `git push --force-with-lease` that no-ops on
    // the remote but pollutes the audit log and wastes round-trips.
    let behindBaseBy = 0;
    try {
      const status = await prService.getStatus(prId);
      behindBaseBy = status.behindBaseBy ?? 0;
    } catch (err) {
      logger.debug("ptm.status_fetch_failed", { prId, error: getErrorMessage(err) });
      // Fall through; treat as "unknown" → safest is to run the base sync.
      behindBaseBy = 1;
    }
    if (!isAutoConvergeStillEnabled(prId)) {
      clearTimer(prId);
      return;
    }

    // ---- Step 1: base-advance conflict check (only when actually behind) ----
    if (behindBaseBy > 0) {
      const baseSync = await applyConflictStrategy(fresh, "base_advance");
      if (!isAutoConvergeStillEnabled(prId)) {
        clearTimer(prId);
        return;
      }
      if (baseSync.kind === "paused") {
        pauseLoop(prId, baseSync.reason);
        return;
      }
      if (baseSync.kind === "failed") {
        pauseLoop(prId, "Base sync failed.", baseSync.error);
        return;
      }
      const headSha = await readCurrentHeadSha(prId);
      await postReviewBotPings(fresh, inProc, headSha);
      schedule(prId, "justPushed");
      return;
    }

    // Helper: persist a "converged but not auto-merging" parked state. Used
    // when `pipelineSettings.autoMerge === false` — the loop gets the PR into
    // a green/clean state but stops short of landing it.
    const parkConverged = (reason: string): void => {
      issueInventoryService.saveConvergenceRuntime(prId, {
        status: "converged",
        pollerStatus: "waiting_for_comments",
        pauseReason: reason,
        errorMessage: null,
      });
      schedule(prId, "waitingOnReview");
    };

    // Helper: persist a "merge armed via gh --auto" parked state. The PR has
    // not actually landed; GitHub will land it when its required gates clear.
    // We re-poll `pr.state` until that transition is observed.
    const parkAutoArmed = (): void => {
      issueInventoryService.saveConvergenceRuntime(prId, {
        status: "converged",
        pollerStatus: "waiting_for_checks",
        mergeWaitKind: "github_auto_merge_armed",
        pauseReason: "auto-merge armed via gh CLI; waiting for GitHub to land.",
        errorMessage: null,
      });
      schedule(prId, "waitingOnReview");
    };

    // ---- Step 2: early merge on green (shipLane intent) ----
    if (fresh.pipelineSettings.earlyMergeOnGreen) {
      const reviewClean = fresh.pr.reviewStatus !== "changes_requested" && fresh.pr.reviewStatus !== "requested";
      if (fresh.pr.checksStatus === "passing" && reviewClean) {
        if (!fresh.pipelineSettings.autoMerge) {
          // User has explicitly opted out of auto-merge: stop short of landing.
          parkConverged("Converged but pipelineSettings.autoMerge is false; click merge when ready.");
          return;
        }
        const ladder = await runMergeLadder(fresh);
        if (!isAutoConvergeStillEnabled(prId)) {
          clearTimer(prId);
          return;
        }
        if (ladder.kind === "merged") {
          releaseLoopLock(prId);
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
        if (ladder.kind === "auto_armed") {
          parkAutoArmed();
          return;
        }
        if (ladder.kind === "conflict") {
          // Apply merge-time conflict strategy and retry on next wake.
          const conflictRes = await applyConflictStrategy(fresh, "merge_time");
          if (!isAutoConvergeStillEnabled(prId)) {
            clearTimer(prId);
            return;
          }
          if (conflictRes.kind === "paused") {
            pauseLoop(prId, conflictRes.reason);
            return;
          }
          if (conflictRes.kind === "failed") {
            pauseLoop(prId, "Merge-time conflict resolution failed.", conflictRes.error);
            return;
          }
          await postReviewBotPings(fresh, inProc, await readCurrentHeadSha(prId));
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

    const maxRounds = fresh.pipelineSettings.maxRounds;
    const completedRounds = fresh.runtime.currentRound;
    const atCap = completedRounds >= maxRounds;
    const afterForceFinalizePush = atCap && (inProc.ciRetryAttemptsUsed > 0 || inProc.forceFinalizeUsed);

    // ---- Step 3: terminal-gate check before dispatching fixes ----
    const gate = atCap
      ? { terminal: CHECKS_TERMINAL_STATUSES.has(fresh.pr.checksStatus), pendingSignal: "checks" as const }
      : isTerminalForFixPush(fresh.pr);
    if (!gate.terminal) {
      logger.info("ptm.terminal_gate_pending", { prId, pendingSignal: gate.pendingSignal });
      issueInventoryService.saveConvergenceRuntime(prId, {
        pollerStatus: gate.pendingSignal === "review" ? "waiting_for_comments" : "waiting_for_checks",
        currentRound: fresh.runtime.currentRound,
      });
      schedule(prId, "warming");
      return;
    }

    if (!afterForceFinalizePush) {
      const pendingReviewBots = getPendingReviewBots(latestChecks, latestComments, latestReviews, inProc);
      if (pendingReviewBots.length > 0) {
        logger.info("ptm.review_bots_pending", { prId, pendingReviewBots });
        issueInventoryService.saveConvergenceRuntime(prId, {
          pollerStatus: "waiting_for_comments",
          currentRound: fresh.runtime.currentRound,
        });
        schedule(prId, "warming");
        return;
      }
    }

    // ---- Step 4: hard cap + at-cap policy logic ----
    inProcessState.set(prId, inProc);

    let isAtCapDispatchCi = false;
    let isAtCapMergeNow = false;
    if (atCap) {
      if (inProc.forceFinalizeUsed) {
        // Bonus merge ladder already attempted; nothing left to try.
        pauseLoop(prId, "Hard cap reached (at-cap action already attempted).");
        return;
      }
      let checks: PrCheck[] = [];
      try {
        checks = await prService.getChecks(prId);
      } catch (err) {
        logger.warn("ptm.at_cap_checks_fetch_failed", { prId, error: getErrorMessage(err) });
      }
      if (!isAutoConvergeStillEnabled(prId)) {
        clearTimer(prId);
        return;
      }
      const decision = decideAtCapAction(fresh, checks, inProc);
      persistInProcessState(prId, inProc);
      logger.info("ptm.at_cap_decision", { prId, policy: fresh.pipelineSettings.atCapPolicy, decisionKind: decision.kind, reason: decision.reason });
      if (decision.kind === "stop") {
        pauseLoop(prId, `Hard cap reached: ${decision.reason}`);
        return;
      }
      if (decision.kind === "wait") {
        // Wait but do NOT write `pauseReason` — the loop is still alive.
        // QueueTab/PrDetailPane render any non-null pauseReason as "paused:
        // <reason>" regardless of runtime status, so a wait reason would lie
        // about the loop being paused when it's actually polling.
        issueInventoryService.saveConvergenceRuntime(prId, {
          pollerStatus: "waiting_for_checks",
        });
        schedule(prId, decision.phase);
        return;
      }
      if (decision.kind === "dispatch_ci") {
        isAtCapDispatchCi = true;
        issueInventoryService.saveConvergenceRuntime(prId, {
          pauseReason: "force-finalize",
        });
      } else {
        // decision.kind === "merge_now"
        isAtCapMergeNow = true;
      }
    }

    // ---- Step 5: dispatch fix agent (or skip if at-cap merge_now) ----
    const shouldSkipFixDispatch = isAtCapMergeNow;

    if (!shouldSkipFixDispatch) {
      // Busy-guard: if a fix agent is still running from a previous iteration,
      // do NOT dispatch another. Two agents racing on the same worktree
      // corrupts pushes and orphans the first session's reconciliation row.
      const priorSessionId = fresh.runtime.activeSessionId?.trim() ?? null;
      if (priorSessionId) {
        let priorActive = false;
        let priorSessionFinished = false;
        let priorMissing = false;
        try {
          const summary = await agentChatService.getSessionSummary(priorSessionId);
          if (!isAutoConvergeStillEnabled(prId)) {
            clearTimer(prId);
            return;
          }
          if (summary == null) {
            priorMissing = true;
            priorActive = true;
          } else if (summary.status === "active") {
            priorActive = true;
          } else if (summary.status === "idle" && summary.awaitingInput === true) {
            pauseLoop(prId, "Fix agent is awaiting user input; Path to Merge cannot continue unattended.");
            return;
          } else {
            priorSessionFinished = true;
          }
          if (summary != null) {
            inProc.sessionMissingPolls = 0;
            inProc.sessionMissingSessionId = null;
            persistInProcessState(prId, inProc);
          }
        } catch (err) {
          logger.warn("ptm.session_alive_check_failed", { prId, sessionId: priorSessionId, error: getErrorMessage(err) });
          if (!isAutoConvergeStillEnabled(prId)) {
            clearTimer(prId);
            return;
          }
          priorMissing = true;
          priorActive = true;
        }
        if (priorMissing) {
          if (inProc.sessionMissingSessionId !== priorSessionId) {
            inProc.sessionMissingSessionId = priorSessionId;
            inProc.sessionMissingPolls = 0;
          }
          inProc.sessionMissingPolls += 1;
          persistInProcessState(prId, inProc);
          if (inProc.sessionMissingPolls >= 2) {
            logger.warn("ptm.session_missing_giving_up", { prId, sessionId: priorSessionId, missingPolls: inProc.sessionMissingPolls });
            inProc.sessionMissingPolls = 0;
            inProc.sessionMissingSessionId = null;
            issueInventoryService.saveConvergenceRuntime(prId, {
              activeSessionId: null,
              activeLaneId: null,
              activeHref: null,
            });
            persistInProcessState(prId, inProc);
            priorActive = false;
            priorSessionFinished = false;
          }
        }
        if (priorActive) {
          logger.info("ptm.fix_agent_still_running_skipping_dispatch", { prId, sessionId: priorSessionId });
          schedule(prId, "warming");
          return;
        }
        if (priorSessionFinished && inProc.lastDispatchHeadSha) {
          const currentHeadSha = await readCurrentHeadSha(prId);
          if (!isAutoConvergeStillEnabled(prId)) {
            clearTimer(prId);
            return;
          }
          if (currentHeadSha && currentHeadSha === inProc.lastDispatchHeadSha) {
            inProc.lastDispatchHeadSha = null;
            persistInProcessState(prId, inProc);
            pauseLoop(prId, "Fix agent finished without pushing commits - manual intervention needed.");
            return;
          }
          if (currentHeadSha && currentHeadSha !== inProc.lastDispatchHeadSha) {
            inProc.lastDispatchHeadSha = null;
            issueInventoryService.saveConvergenceRuntime(prId, {
              activeSessionId: null,
              activeLaneId: null,
              activeHref: null,
              pollerStatus: "waiting_for_comments",
            });
            persistInProcessState(prId, inProc);
            await postReviewBotPings(fresh, inProc, currentHeadSha);
            schedule(prId, "justPushed");
            return;
          }
        }
      }

      const convergenceStatus = issueInventoryService.getConvergenceStatus(prId);
      if (convergenceStatus.totalNew === 0) {
        if (!fresh.pipelineSettings.autoMerge) {
          parkConverged("Inventory clean; nothing to dispatch.");
          return;
        }
        const ladder = await runMergeLadder(fresh);
        if (!isAutoConvergeStillEnabled(prId)) {
          clearTimer(prId);
          return;
        }
        if (ladder.kind === "merged") {
          releaseLoopLock(prId);
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
        if (ladder.kind === "auto_armed") {
          parkAutoArmed();
          return;
        }
        if (ladder.kind === "conflict") {
          const conflictRes = await applyConflictStrategy(fresh, "merge_time");
          if (!isAutoConvergeStillEnabled(prId)) {
            clearTimer(prId);
            return;
          }
          if (conflictRes.kind === "paused") {
            pauseLoop(prId, conflictRes.reason);
            return;
          }
          if (conflictRes.kind === "failed") {
            pauseLoop(prId, "Clean-inventory merge-time conflict resolution failed.", conflictRes.error);
            return;
          }
          await postReviewBotPings(fresh, inProc, await readCurrentHeadSha(prId));
          schedule(prId, "justPushed");
          return;
        }
        if (ladder.kind === "blocked") {
          if (isPermanentCleanInventoryBlocker(fresh, ladder.error)) {
            pauseLoop(prId, "Clean inventory cannot auto-merge.", ladder.error);
            return;
          }
          parkConverged(`Inventory clean; merge ladder is blocked: ${ladder.error}`);
          return;
        }
        pauseLoop(prId, "Clean-inventory merge ladder failed.", ladder.error);
        return;
      }

      let requestedScope: PrIssueResolutionScope;
      if (isAtCapDispatchCi) {
        // shipLane line 189: ignore review, only run CI fixes.
        requestedScope = "checks";
      } else {
        requestedScope = inProc.runArgs.scope ?? "both";
      }
      const scope = await resolveDispatchScope(prId, requestedScope, { allowFallback: !isAtCapDispatchCi });
      if (!scope) {
        parkConverged("Inventory clean; no currently actionable CI or review issues remain.");
        return;
      }

      const modelId = inProc.runArgs.modelId?.trim() || deps.defaultModelId?.trim() || null;
      if (!modelId) {
        pauseLoop(prId, "No modelId available to dispatch fix agent.");
        return;
      }

      try {
        const dispatchHeadSha = await readCurrentHeadSha(prId);
        if (!isAutoConvergeStillEnabled(prId)) {
          clearTimer(prId);
          return;
        }
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
            laneWorktreeLockService,
          },
          {
            prId,
            scope,
            modelId,
            reasoning: inProc.runArgs.reasoning ?? deps.defaultReasoningEffort ?? null,
            permissionMode: inProc.runArgs.permissionMode ?? undefined,
            additionalInstructions: inProc.runArgs.additionalInstructions ?? null,
            laneWorktreeLockToken: inProc.laneWorktreeLockToken,
          } as Parameters<typeof launchPrIssueResolutionChat>[1] & { laneWorktreeLockToken?: string | null },
        );
        if (!isAutoConvergeStillEnabled(prId)) {
          clearTimer(prId);
          issueInventoryService.resetSentToAgent(prId, { sessionId: launch.sessionId });
          return;
        }

        // NOTE: forceFinalizeUsed is intentionally NOT set here. The bonus
        // merge ladder is consumed in Step 6, not by a fix dispatch —
        // otherwise the at-cap CI-retry policies would degrade to "one extra
        // fix iteration, then pause" and never actually retry the merge once
        // the agent's fix turned CI green. The at-cap policy decider gates
        // further retries via inProc.ciRetryAttemptsUsed.
        inProc.lastDispatchHeadSha = dispatchHeadSha;
        persistInProcessState(prId, inProc);

        const status = issueInventoryService.getConvergenceStatus(prId);
        issueInventoryService.saveConvergenceRuntime(prId, {
          status: "running",
          pollerStatus: "waiting_for_comments",
          currentRound: status.currentRound,
          activeSessionId: launch.sessionId,
          activeLaneId: launch.laneId,
          activeHref: launch.href,
          pauseReason: isAtCapDispatchCi ? "force-finalize" : null,
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

    // ---- Step 6: at-cap merge_now path → straight to merge ladder ----
    if (isAtCapMergeNow) {
      if (!fresh.pipelineSettings.autoMerge) {
        // User opted into an at-cap policy but not auto-merge: park instead of land.
        inProc.forceFinalizeUsed = true;
        persistInProcessState(prId, inProc);
        parkConverged("At-cap policy decided to merge but autoMerge is off; click merge when ready.");
        return;
      }

      // Consume the bonus only when we actually attempt the merge ladder.
      inProc.forceFinalizeUsed = true;
      persistInProcessState(prId, inProc);

      const ladder = await runMergeLadder(fresh, {
        allowForceMerge: fresh.pipelineSettings.atCapPolicy === "force_merge",
      });
      if (!isAutoConvergeStillEnabled(prId)) {
        clearTimer(prId);
        return;
      }
      if (ladder.kind === "merged") {
        releaseLoopLock(prId);
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
      if (ladder.kind === "auto_armed") {
        parkAutoArmed();
        return;
      }
      if (ladder.kind === "conflict") {
        const conflictRes = await applyConflictStrategy(fresh, "merge_time");
        if (!isAutoConvergeStillEnabled(prId)) {
          clearTimer(prId);
          return;
        }
        if (conflictRes.kind === "paused") {
          pauseLoop(prId, conflictRes.reason);
          return;
        }
        if (conflictRes.kind === "failed") {
          pauseLoop(prId, "At-cap merge-time conflict resolution failed.", conflictRes.error);
          return;
        }
        await postReviewBotPings(fresh, inProc, await readCurrentHeadSha(prId));
        schedule(prId, "justPushed");
        return;
      }
      if (ladder.kind === "blocked") {
        failLoop(prId, `At-cap merge ladder blocked: ${ladder.error}`);
        return;
      }
      failLoop(prId, `At-cap merge ladder failed: ${ladder.error}`);
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
