import type { AdeDb } from "../state/kvDb";
import type {
  AtCapPolicy,
  AutoConflictAgentProvider,
  AutoConflictAgentSettings,
  ConflictStrategy,
  ConvergenceRuntimeState,
  ForceFinalizeMode,
  PipelineSettings,
} from "../../../shared/types";
import {
  DEFAULT_AUTO_CONFLICT_AGENT_SETTINGS,
  DEFAULT_CONVERGENCE_RUNTIME_STATE,
  DEFAULT_PIPELINE_SETTINGS,
  atCapPolicyFromLegacy,
  conflictStrategyFromLegacyRebasePolicy,
  legacyRebasePolicyFromConflictStrategy,
} from "../../../shared/types";
import { nowIso } from "../shared/utils";

const CONFLICT_STRATEGY_VALUES = new Set<ConflictStrategy>(["pause", "rebase", "merge", "auto"]);
const FORCE_FINALIZE_MODE_VALUES = new Set<ForceFinalizeMode>(["off", "unconditional", "conditional"]);
const AT_CAP_POLICY_VALUES = new Set<AtCapPolicy>([
  "stop",
  "wait_for_ci",
  "ci_retry_once",
  "ci_retry_loop",
  "force_merge",
]);
const AUTO_AGENT_PROVIDER_VALUES = new Set<AutoConflictAgentProvider>(["claude", "codex"]);

const CONVERGENCE_RUNTIME_STATUS_VALUES = new Set<ConvergenceRuntimeState["status"]>([
  "idle",
  "launching",
  "running",
  "polling",
  "paused",
  "converged",
  "merged",
  "failed",
  "cancelled",
  "stopped",
]);

const CONVERGENCE_POLLER_STATUS_VALUES = new Set<ConvergenceRuntimeState["pollerStatus"]>([
  "idle",
  "scheduled",
  "polling",
  "waiting_for_checks",
  "waiting_for_comments",
  "paused",
  "stopped",
]);

const CONVERGENCE_MERGE_WAIT_KIND_VALUES = new Set<NonNullable<ConvergenceRuntimeState["mergeWaitKind"]>>([
  "github_auto_merge_armed",
]);

// ---------------------------------------------------------------------------
// Convergence runtime row
// ---------------------------------------------------------------------------

type ConvergenceRuntimeRow = {
  pr_id: string;
  auto_converge_enabled: number;
  status: string;
  poller_status: string;
  merge_wait_kind: string | null;
  current_round: number;
  active_session_id: string | null;
  active_lane_id: string | null;
  active_href: string | null;
  pause_reason: string | null;
  error_message: string | null;
  force_finalize_used: number | null;
  ci_retry_attempts_used: number | null;
  wait_for_ci_started_at: string | null;
  last_dispatch_head_sha: string | null;
  last_bot_ping_head_sha: string | null;
  last_bot_ping_at: string | null;
  pause_repeat_count: number | null;
  last_pause_reason_hash: string | null;
  last_started_at: string | null;
  last_polled_at: string | null;
  last_paused_at: string | null;
  last_stopped_at: string | null;
  created_at: string;
  updated_at: string;
};

function buildDefaultRuntimeState(prId: string): ConvergenceRuntimeState {
  const now = nowIso();
  return {
    prId,
    ...DEFAULT_CONVERGENCE_RUNTIME_STATE,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Validates renderer-supplied runtime fields before persisting.
 * Throws on clearly malformed data (wrong types, unknown enum values,
 * negative rounds) rather than silently correcting.
 */
function validateConvergenceRuntimeState(state: Partial<ConvergenceRuntimeState>): void {
  if (state.autoConvergeEnabled !== undefined && typeof state.autoConvergeEnabled !== "boolean") {
    throw new Error(`Invalid autoConvergeEnabled: expected a boolean, got ${JSON.stringify(state.autoConvergeEnabled)}`);
  }
  if (state.pathToMergeActive !== undefined && typeof state.pathToMergeActive !== "boolean") {
    throw new Error(`Invalid pathToMergeActive: expected a boolean, got ${JSON.stringify(state.pathToMergeActive)}`);
  }
  if (state.status !== undefined) {
    if (typeof state.status !== "string" || !CONVERGENCE_RUNTIME_STATUS_VALUES.has(state.status as ConvergenceRuntimeState["status"])) {
      throw new Error(`Invalid convergence runtime status: ${JSON.stringify(state.status)}`);
    }
  }
  if (state.pollerStatus !== undefined) {
    if (typeof state.pollerStatus !== "string" || !CONVERGENCE_POLLER_STATUS_VALUES.has(state.pollerStatus as ConvergenceRuntimeState["pollerStatus"])) {
      throw new Error(`Invalid convergence poller status: ${JSON.stringify(state.pollerStatus)}`);
    }
  }
  if (state.mergeWaitKind !== undefined && state.mergeWaitKind !== null) {
    if (typeof state.mergeWaitKind !== "string" || !CONVERGENCE_MERGE_WAIT_KIND_VALUES.has(state.mergeWaitKind as NonNullable<ConvergenceRuntimeState["mergeWaitKind"]>)) {
      throw new Error(`Invalid convergence merge wait kind: ${JSON.stringify(state.mergeWaitKind)}`);
    }
  }
  if (state.currentRound !== undefined) {
    if (typeof state.currentRound !== "number" || !Number.isFinite(state.currentRound)) {
      throw new Error(`Invalid currentRound: expected a finite number, got ${JSON.stringify(state.currentRound)}`);
    }
    if (state.currentRound < 0 || !Number.isInteger(state.currentRound)) {
      throw new Error(`Invalid currentRound: expected a non-negative integer, got ${state.currentRound}`);
    }
  }
  if (state.forceFinalizeUsed !== undefined && typeof state.forceFinalizeUsed !== "boolean") {
    throw new Error(`Invalid forceFinalizeUsed: expected a boolean, got ${JSON.stringify(state.forceFinalizeUsed)}`);
  }
  for (const field of ["ciRetryAttemptsUsed", "pauseRepeatCount"] as const) {
    const value = state[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error(`Invalid ${field}: expected a non-negative integer, got ${JSON.stringify(value)}`);
    }
  }
  for (const field of [
    "activeSessionId",
    "activeLaneId",
    "activeHref",
    "pauseReason",
    "errorMessage",
    "waitForCiStartedAt",
    "lastDispatchHeadSha",
    "lastBotPingHeadSha",
    "lastBotPingAt",
    "lastPauseReasonHash",
    "lastStartedAt",
    "lastPolledAt",
    "lastPausedAt",
    "lastStoppedAt",
    "createdAt",
    "updatedAt",
  ] as const) {
    const value = state[field];
    if (value != null && typeof value !== "string") {
      throw new Error(`Invalid ${field}: expected a string, got ${JSON.stringify(value)}`);
    }
  }
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeConvergenceRuntimeState(
  prId: string,
  state: ConvergenceRuntimeState,
): ConvergenceRuntimeState {
  const now = nowIso();
  const mergeWaitKind = state.mergeWaitKind && CONVERGENCE_MERGE_WAIT_KIND_VALUES.has(state.mergeWaitKind)
    ? state.mergeWaitKind
    : null;
  return {
    prId,
    autoConvergeEnabled: state.autoConvergeEnabled,
    pathToMergeActive: state.pathToMergeActive,
    status: state.status,
    pollerStatus: state.pollerStatus,
    mergeWaitKind: state.status === "converged" && state.pollerStatus === "waiting_for_checks"
      ? mergeWaitKind
      : null,
    currentRound: state.currentRound,
    activeSessionId: trimOrNull(state.activeSessionId),
    activeLaneId: trimOrNull(state.activeLaneId),
    activeHref: trimOrNull(state.activeHref),
    pauseReason: trimOrNull(state.pauseReason),
    errorMessage: trimOrNull(state.errorMessage),
    forceFinalizeUsed: state.forceFinalizeUsed,
    ciRetryAttemptsUsed: Math.max(0, Math.floor(state.ciRetryAttemptsUsed)),
    waitForCiStartedAt: trimOrNull(state.waitForCiStartedAt),
    lastDispatchHeadSha: trimOrNull(state.lastDispatchHeadSha),
    lastBotPingHeadSha: trimOrNull(state.lastBotPingHeadSha),
    lastBotPingAt: trimOrNull(state.lastBotPingAt),
    pauseRepeatCount: Math.max(0, Math.floor(state.pauseRepeatCount)),
    lastPauseReasonHash: trimOrNull(state.lastPauseReasonHash),
    lastStartedAt: trimOrNull(state.lastStartedAt),
    lastPolledAt: trimOrNull(state.lastPolledAt),
    lastPausedAt: trimOrNull(state.lastPausedAt),
    lastStoppedAt: trimOrNull(state.lastStoppedAt),
    createdAt: trimOrNull(state.createdAt) ?? now,
    updatedAt: trimOrNull(state.updatedAt) ?? now,
  };
}

function rowToConvergenceRuntime(row: ConvergenceRuntimeRow): ConvergenceRuntimeState {
  return sanitizeConvergenceRuntimeState(row.pr_id, {
    prId: row.pr_id,
    autoConvergeEnabled: row.auto_converge_enabled === 1,
    pathToMergeActive: false,
    status: row.status as ConvergenceRuntimeState["status"],
    pollerStatus: row.poller_status as ConvergenceRuntimeState["pollerStatus"],
    mergeWaitKind: row.merge_wait_kind as ConvergenceRuntimeState["mergeWaitKind"],
    currentRound: row.current_round,
    activeSessionId: row.active_session_id,
    activeLaneId: row.active_lane_id,
    activeHref: row.active_href,
    pauseReason: row.pause_reason,
    errorMessage: row.error_message,
    forceFinalizeUsed: row.force_finalize_used === 1,
    ciRetryAttemptsUsed: row.ci_retry_attempts_used ?? 0,
    waitForCiStartedAt: row.wait_for_ci_started_at,
    lastDispatchHeadSha: row.last_dispatch_head_sha,
    lastBotPingHeadSha: row.last_bot_ping_head_sha,
    lastBotPingAt: row.last_bot_ping_at,
    pauseRepeatCount: row.pause_repeat_count ?? 0,
    lastPauseReasonHash: row.last_pause_reason_hash,
    lastStartedAt: row.last_started_at,
    lastPolledAt: row.last_polled_at,
    lastPausedAt: row.last_paused_at,
    lastStoppedAt: row.last_stopped_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

// ---------------------------------------------------------------------------
// Service
//
// Slim persistence backing Path to Merge: convergence runtime state, the opaque
// Path-to-Merge launch args blob, and pipeline settings. The agent watcher pulls
// raw PR state via `gh`/`ade` itself, so there is no longer any review-comment
// inventory or convergence digestion here.
// ---------------------------------------------------------------------------

export function createIssueInventoryService(deps: { db: AdeDb }) {
  const { db } = deps;

  function hasPathToMergeArgs(prId: string): boolean {
    const row = db.get<{ ptm_args_json: string | null }>(
      "select ptm_args_json from pr_convergence_state where pr_id = ?",
      [prId],
    );
    return typeof row?.ptm_args_json === "string" && row.ptm_args_json.trim().length > 0;
  }

  function attachPathToMergeOwnership(runtime: ConvergenceRuntimeState): ConvergenceRuntimeState {
    const liveNativeRuntime = runtime.autoConvergeEnabled
      && runtime.status !== "cancelled"
      && runtime.status !== "failed"
      && runtime.status !== "merged"
      && runtime.status !== "stopped"
      && runtime.pollerStatus !== "stopped";
    return {
      ...runtime,
      pathToMergeActive: liveNativeRuntime && hasPathToMergeArgs(runtime.prId),
    };
  }

  function computeEffectiveRuntime(
    persisted: ConvergenceRuntimeState,
    patch?: Partial<ConvergenceRuntimeState>,
  ): ConvergenceRuntimeState {
    return {
      ...persisted,
      ...patch,
    };
  }

  function readPipelineSettings(prId: string): PipelineSettings {
    const row = db.get<{
      merge_method: string;
      max_rounds: number;
      on_rebase_needed: string;
      conflict_strategy: string | null;
      force_finalize_mode: string | null;
      force_finalize_require_no_ci_failures: number | null;
      early_merge_on_green: number | null;
      at_cap_policy: string | null;
      at_cap_wait_minutes: number | null;
      at_cap_ci_retry_max: number | null;
      force_merge_requires_confirmation: number | null;
      auto_agent_provider: string | null;
      auto_agent_model: string | null;
      auto_agent_reasoning_effort: string | null;
      auto_agent_permission_mode: string | null;
      auto_agent_confidence_threshold: number | null;
    }>(
      `select merge_method, max_rounds, on_rebase_needed,
              conflict_strategy, force_finalize_mode,
              force_finalize_require_no_ci_failures, early_merge_on_green,
              at_cap_policy, at_cap_wait_minutes, at_cap_ci_retry_max,
              force_merge_requires_confirmation,
              auto_agent_provider, auto_agent_model, auto_agent_reasoning_effort,
              auto_agent_permission_mode, auto_agent_confidence_threshold
       from pr_pipeline_settings where pr_id = ?`,
      [prId],
    );
    if (!row) return { ...DEFAULT_PIPELINE_SETTINGS, autoAgentSettings: { ...DEFAULT_AUTO_CONFLICT_AGENT_SETTINGS } };

    const onRebaseNeeded = row.on_rebase_needed as PipelineSettings["onRebaseNeeded"];
    const rawConflictStrategy = row.conflict_strategy;
    const conflictStrategy: ConflictStrategy = rawConflictStrategy && CONFLICT_STRATEGY_VALUES.has(rawConflictStrategy as ConflictStrategy)
      ? (rawConflictStrategy as ConflictStrategy)
      : conflictStrategyFromLegacyRebasePolicy(onRebaseNeeded);

    const rawForceFinalize = row.force_finalize_mode;
    const forceFinalizeMode: ForceFinalizeMode = rawForceFinalize && FORCE_FINALIZE_MODE_VALUES.has(rawForceFinalize as ForceFinalizeMode)
      ? (rawForceFinalize as ForceFinalizeMode)
      : DEFAULT_PIPELINE_SETTINGS.forceFinalizeMode;

    // Prefer the new at_cap_policy column when present; otherwise derive from
    // the legacy force_finalize_mode so older rows keep working.
    const rawAtCap = row.at_cap_policy;
    const atCapPolicy: AtCapPolicy = rawAtCap && AT_CAP_POLICY_VALUES.has(rawAtCap as AtCapPolicy)
      ? (rawAtCap as AtCapPolicy)
      : atCapPolicyFromLegacy(forceFinalizeMode);
    const atCapWaitMinutes = row.at_cap_wait_minutes ?? DEFAULT_PIPELINE_SETTINGS.atCapWaitMinutes;
    const atCapCiRetryMax = row.at_cap_ci_retry_max ?? DEFAULT_PIPELINE_SETTINGS.atCapCiRetryMax;
    const forceMergeRequiresConfirmation = row.force_merge_requires_confirmation == null
      ? DEFAULT_PIPELINE_SETTINGS.forceMergeRequiresConfirmation
      : row.force_merge_requires_confirmation === 1;

    const rawProvider = row.auto_agent_provider;
    const provider: AutoConflictAgentProvider | null = rawProvider && AUTO_AGENT_PROVIDER_VALUES.has(rawProvider as AutoConflictAgentProvider)
      ? (rawProvider as AutoConflictAgentProvider)
      : null;

    const autoAgentSettings: AutoConflictAgentSettings = {
      provider,
      model: row.auto_agent_model,
      reasoningEffort: row.auto_agent_reasoning_effort,
      permissionMode: row.auto_agent_permission_mode as AutoConflictAgentSettings["permissionMode"],
      confidenceThreshold: row.auto_agent_confidence_threshold,
    };

    return {
      mergeMethod: row.merge_method as PipelineSettings["mergeMethod"],
      maxRounds: row.max_rounds,
      onRebaseNeeded,
      conflictStrategy,
      autoAgentSettings,
      forceFinalizeMode,
      forceFinalizeRequireNoCiFailures: (row.force_finalize_require_no_ci_failures ?? 1) === 1,
      atCapPolicy,
      atCapWaitMinutes,
      atCapCiRetryMax,
      forceMergeRequiresConfirmation,
      earlyMergeOnGreen: (row.early_merge_on_green ?? 1) === 1,
    };
  }

  function getConvergenceRuntimeRow(prId: string): ConvergenceRuntimeRow | null {
    return db.get<ConvergenceRuntimeRow>(
      "select * from pr_convergence_state where pr_id = ?",
      [prId],
    );
  }

  function saveConvergenceRuntimeState(prId: string, state: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState {
    validateConvergenceRuntimeState(state);
    const existing = readConvergenceRuntime(prId);
    const effective = computeEffectiveRuntime(existing, state);
    const merged = sanitizeConvergenceRuntimeState(prId, {
      ...effective,
      prId,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });

    db.run(
      `insert into pr_convergence_state
         (pr_id, auto_converge_enabled, status, poller_status, merge_wait_kind, current_round, active_session_id,
          active_lane_id, active_href, pause_reason, error_message,
          force_finalize_used, ci_retry_attempts_used, wait_for_ci_started_at,
          last_dispatch_head_sha, last_bot_ping_head_sha, last_bot_ping_at,
          pause_repeat_count, last_pause_reason_hash,
          last_started_at, last_polled_at, last_paused_at, last_stopped_at,
          created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(pr_id) do update set
         auto_converge_enabled = excluded.auto_converge_enabled,
         status = excluded.status,
         poller_status = excluded.poller_status,
         merge_wait_kind = excluded.merge_wait_kind,
         current_round = excluded.current_round,
         active_session_id = excluded.active_session_id,
         active_lane_id = excluded.active_lane_id,
         active_href = excluded.active_href,
         pause_reason = excluded.pause_reason,
         error_message = excluded.error_message,
         force_finalize_used = excluded.force_finalize_used,
         ci_retry_attempts_used = excluded.ci_retry_attempts_used,
         wait_for_ci_started_at = excluded.wait_for_ci_started_at,
         last_dispatch_head_sha = excluded.last_dispatch_head_sha,
         last_bot_ping_head_sha = excluded.last_bot_ping_head_sha,
         last_bot_ping_at = excluded.last_bot_ping_at,
         pause_repeat_count = excluded.pause_repeat_count,
         last_pause_reason_hash = excluded.last_pause_reason_hash,
         last_started_at = excluded.last_started_at,
         last_polled_at = excluded.last_polled_at,
         last_paused_at = excluded.last_paused_at,
         last_stopped_at = excluded.last_stopped_at,
         updated_at = excluded.updated_at`,
      [
        merged.prId,
        merged.autoConvergeEnabled ? 1 : 0,
        merged.status,
        merged.pollerStatus,
        merged.mergeWaitKind,
        merged.currentRound,
        merged.activeSessionId,
        merged.activeLaneId,
        merged.activeHref,
        merged.pauseReason,
        merged.errorMessage,
        merged.forceFinalizeUsed ? 1 : 0,
        merged.ciRetryAttemptsUsed,
        merged.waitForCiStartedAt,
        merged.lastDispatchHeadSha,
        merged.lastBotPingHeadSha,
        merged.lastBotPingAt,
        merged.pauseRepeatCount,
        merged.lastPauseReasonHash,
        merged.lastStartedAt,
        merged.lastPolledAt,
        merged.lastPausedAt,
        merged.lastStoppedAt,
        merged.createdAt,
        merged.updatedAt,
      ],
    );

    return attachPathToMergeOwnership(merged);
  }

  function readConvergenceRuntime(prId: string): ConvergenceRuntimeState {
    const row = getConvergenceRuntimeRow(prId);
    const persisted = row ? rowToConvergenceRuntime(row) : buildDefaultRuntimeState(prId);
    return attachPathToMergeOwnership(computeEffectiveRuntime(persisted));
  }

  return {
    getConvergenceRuntime(prId: string): ConvergenceRuntimeState {
      return readConvergenceRuntime(prId);
    },

    saveConvergenceRuntime(prId: string, state: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState {
      return saveConvergenceRuntimeState(prId, state);
    },

    resetConvergenceRuntime(prId: string): void {
      db.run("delete from pr_convergence_state where pr_id = ?", [prId]);
    },

    /**
     * Persist the original {@link StartPathToMergeArgs} alongside the
     * convergence state so the orchestrator can rehydrate them after a desktop
     * restart. The blob is opaque JSON — typed at the call site.
     */
    savePathToMergeArgs(prId: string, args: Record<string, unknown> | null): void {
      // Make sure the row exists so the alter-table column has somewhere to land.
      readConvergenceRuntime(prId);
      saveConvergenceRuntimeState(prId, {});
      const payload = args == null ? null : JSON.stringify(args);
      db.run(
        "update pr_convergence_state set ptm_args_json = ? where pr_id = ?",
        [payload, prId],
      );
    },

    getPathToMergeArgs(prId: string): Record<string, unknown> | null {
      const row = db.get<{ ptm_args_json: string | null }>(
        "select ptm_args_json from pr_convergence_state where pr_id = ?",
        [prId],
      );
      const raw = row?.ptm_args_json;
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch {
        return null;
      }
    },

    // ----- Pipeline settings -----

    getPipelineSettings(prId: string): PipelineSettings {
      return readPipelineSettings(prId);
    },

    savePipelineSettings(prId: string, settings: Partial<PipelineSettings>): void {
      const current = readPipelineSettings(prId);
      const merged: PipelineSettings = {
        ...current,
        ...settings,
        autoAgentSettings: settings.autoAgentSettings
          ? { ...current.autoAgentSettings, ...settings.autoAgentSettings }
          : current.autoAgentSettings,
      };
      // Keep the legacy `onRebaseNeeded` column in sync with the authoritative
      // `conflictStrategy` so older readers (and the iOS sync layer) see a
      // coherent value.
      merged.onRebaseNeeded = legacyRebasePolicyFromConflictStrategy(merged.conflictStrategy);
      const now = nowIso();
      db.run(
        `insert into pr_pipeline_settings (
           pr_id, merge_method, max_rounds, on_rebase_needed,
           conflict_strategy, force_finalize_mode,
           force_finalize_require_no_ci_failures, early_merge_on_green,
           at_cap_policy, at_cap_wait_minutes, at_cap_ci_retry_max,
           force_merge_requires_confirmation,
           auto_agent_provider, auto_agent_model, auto_agent_reasoning_effort,
           auto_agent_permission_mode, auto_agent_confidence_threshold,
           updated_at
         )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(pr_id) do update set
           merge_method = excluded.merge_method,
           max_rounds = excluded.max_rounds,
           on_rebase_needed = excluded.on_rebase_needed,
           conflict_strategy = excluded.conflict_strategy,
           force_finalize_mode = excluded.force_finalize_mode,
           force_finalize_require_no_ci_failures = excluded.force_finalize_require_no_ci_failures,
           early_merge_on_green = excluded.early_merge_on_green,
           at_cap_policy = excluded.at_cap_policy,
           at_cap_wait_minutes = excluded.at_cap_wait_minutes,
           at_cap_ci_retry_max = excluded.at_cap_ci_retry_max,
           force_merge_requires_confirmation = excluded.force_merge_requires_confirmation,
           auto_agent_provider = excluded.auto_agent_provider,
           auto_agent_model = excluded.auto_agent_model,
           auto_agent_reasoning_effort = excluded.auto_agent_reasoning_effort,
           auto_agent_permission_mode = excluded.auto_agent_permission_mode,
           auto_agent_confidence_threshold = excluded.auto_agent_confidence_threshold,
           updated_at = excluded.updated_at`,
        [
          prId,
          merged.mergeMethod,
          merged.maxRounds,
          merged.onRebaseNeeded,
          merged.conflictStrategy,
          merged.forceFinalizeMode,
          merged.forceFinalizeRequireNoCiFailures ? 1 : 0,
          merged.earlyMergeOnGreen ? 1 : 0,
          merged.atCapPolicy,
          merged.atCapWaitMinutes,
          merged.atCapCiRetryMax,
          merged.forceMergeRequiresConfirmation ? 1 : 0,
          merged.autoAgentSettings.provider,
          merged.autoAgentSettings.model,
          merged.autoAgentSettings.reasoningEffort,
          merged.autoAgentSettings.permissionMode,
          merged.autoAgentSettings.confidenceThreshold,
          now,
        ],
      );
    },

    deletePipelineSettings(prId: string): void {
      db.run("delete from pr_pipeline_settings where pr_id = ?", [prId]);
    },
  };
}
