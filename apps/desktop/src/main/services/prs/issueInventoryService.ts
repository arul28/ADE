import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type {
  AtCapPolicy,
  AutoConflictAgentProvider,
  AutoConflictAgentSettings,
  ConflictStrategy,
  ConvergenceRoundStat,
  ConvergenceStatus,
  ConvergenceRuntimeState,
  ForceFinalizeMode,
  IssueInventoryItem,
  IssueInventorySnapshot,
  IssueInventoryState,
  IssueSource,
  PipelineSettings,
  PrCheck,
  PrComment,
  PrReviewThread,
} from "../../../shared/types";
import {
  DEFAULT_AUTO_CONFLICT_AGENT_SETTINGS,
  DEFAULT_CONVERGENCE_RUNTIME_STATE,
  DEFAULT_PIPELINE_SETTINGS,
  atCapPolicyFromLegacy,
  conflictStrategyFromLegacyRebasePolicy,
  legacyRebasePolicyFromConflictStrategy,
} from "../../../shared/types";

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
import { isNoisyIssueComment, looksLikeResolutionAck } from "./resolverUtils";
import { nowIso } from "../shared/utils";

// ---------------------------------------------------------------------------
// Source detection — auto-detects review bot sources from GitHub author names
// ---------------------------------------------------------------------------

// Canonical name mappings for well-known bots (normalizes variant names).
// Bots not listed here are auto-detected from the [bot] suffix and their
// extracted name is used directly — no code change needed for new bots.
const KNOWN_BOT_ALIASES: Record<string, IssueSource> = {
  "coderabbitai": "coderabbit",
  "chatgpt-codex-connector": "codex",
  "codex": "codex",
  "copilot": "copilot",
  "github-copilot": "copilot",
  "ade-review": "ade",
  "greptile-review": "greptile",
  "greptile": "greptile",
  "seer-code-review": "seer",
  "seer": "seer",
};

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

export function detectSource(author: string | null | undefined): IssueSource {
  const name = (author ?? "").trim();
  if (!name) return "unknown";

  // GitHub Apps always have "[bot]" suffix — extract the base name and normalize.
  const botMatch = name.match(/^(.+?)(?:\[bot\])?$/i);
  const baseName = (botMatch?.[1] ?? name).toLowerCase().trim();

  // Check against known aliases for canonical naming
  const known = KNOWN_BOT_ALIASES[baseName];
  if (known) return known;

  // Auto-detect any GitHub App bot (has [bot] suffix or "bot" in the name)
  if (/\[bot\]/i.test(name)) {
    // Return the base name as-is (e.g. "sonarqube-review" → "sonarqube-review")
    return baseName;
  }
  if (/\bbot\b/i.test(name)) return "bot";

  return "human";
}

// ---------------------------------------------------------------------------
// Severity extraction — reuses the same pattern as prIssueResolver.ts
// ---------------------------------------------------------------------------

export function extractSeverity(value: string): "critical" | "major" | "minor" | null {
  // Match explicit severity words
  const wordMatch = value.match(/\b(Critical|Major|Minor)\b/i);
  if (wordMatch?.[1]) return wordMatch[1].toLowerCase() as "critical" | "major" | "minor";
  // Match Codex P1/P2/P3 priority labels
  if (/\bP1\b/.test(value)) return "critical";
  if (/\bP2\b/.test(value)) return "major";
  if (/\bP3\b/.test(value)) return "minor";
  // Match emoji severity indicators (CodeRabbit uses 🔴 🟠 etc.)
  if (/🔴/.test(value)) return "critical";
  if (/🟠|⚠️/.test(value)) return "major";
  if (/🟡/.test(value)) return "minor";
  // Match "[severity]" bracket patterns
  const bracketMatch = value.match(/\[(critical|major|minor|bug|error|warning|nitpick|nit)\]/i);
  if (bracketMatch?.[1]) {
    const label = bracketMatch[1].toLowerCase();
    if (label === "bug" || label === "error" || label === "critical") return "critical";
    if (label === "warning" || label === "major") return "major";
    return "minor";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Headline extraction — compact summary for display
// ---------------------------------------------------------------------------

function stripEmojiNoise(value: string): string {
  return value
    .replace(/[⚠️🔴🟠🟡🟢🔵⭐🐰🤖💡📝🚨✅❌⬆️🧹🛑✨💥🧪]/g, "")
    .replace(/Potential issue\s*\|?\s*/gi, "")
    .replace(/\*\*(Critical|Major|Minor|Bug|Suggestion|Nitpick|Nit)\*\*\s*[:|]?\s*/gi, "")
    .replace(/^\s*[:|]\s*/, "")
    .trim();
}

function extractHeadline(body: string | null | undefined, fallback: string): string {
  const raw = (body ?? "").trim();
  if (!raw) return fallback;
  // Try to extract a bold title like **Some Title**
  const boldMatch = raw.match(/\*\*([^*]+)\*\*/);
  if (boldMatch?.[1]) {
    const title = stripEmojiNoise(boldMatch[1].trim());
    if (title.length > 0 && title.length <= 120) return title;
  }
  // Fall back to first line, stripped of markdown noise and emoji
  const firstLine = stripEmojiNoise(
    raw.split(/\r?\n/)[0]
      .replace(/[#*>`_~]/g, "")
      .trim(),
  );
  if (firstLine.length > 0) {
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

type InventoryRow = {
  id: string;
  pr_id: string;
  source: string;
  type: string;
  external_id: string;
  state: string;
  round: number;
  file_path: string | null;
  line: number | null;
  severity: string | null;
  headline: string;
  body: string | null;
  author: string | null;
  url: string | null;
  dismiss_reason: string | null;
  agent_session_id: string | null;
  thread_comment_count: number | null;
  thread_latest_comment_id: string | null;
  thread_latest_comment_author: string | null;
  thread_latest_comment_at: string | null;
  thread_latest_comment_source: string | null;
  created_at: string;
  updated_at: string;
};

function rowToItem(row: InventoryRow): IssueInventoryItem {
  return {
    id: row.id,
    prId: row.pr_id,
    source: row.source as IssueSource,
    type: row.type as IssueInventoryItem["type"],
    externalId: row.external_id,
    state: row.state as IssueInventoryState,
    round: row.round,
    filePath: row.file_path,
    line: row.line,
    severity: row.severity as IssueInventoryItem["severity"],
    headline: row.headline,
    body: row.body,
    author: row.author,
    url: row.url,
    dismissReason: row.dismiss_reason,
    agentSessionId: row.agent_session_id,
    threadCommentCount: row.thread_comment_count,
    threadLatestCommentId: row.thread_latest_comment_id,
    threadLatestCommentAuthor: row.thread_latest_comment_author,
    threadLatestCommentAt: row.thread_latest_comment_at,
    threadLatestCommentSource: row.thread_latest_comment_source as IssueSource | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Convergence helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROUNDS = 5;

export function computeConvergenceStatus(items: IssueInventoryItem[], maxRounds: number = DEFAULT_MAX_ROUNDS): ConvergenceStatus {
  let totalNew = 0;
  let totalFixed = 0;
  let totalDismissed = 0;
  let totalEscalated = 0;
  let totalSentToAgent = 0;
  let currentRound = 0;

  const roundMap = new Map<number, ConvergenceRoundStat>();
  for (const item of items) {
    switch (item.state) {
      case "new": totalNew++; break;
      case "fixed": totalFixed++; break;
      case "dismissed": totalDismissed++; break;
      case "escalated": totalEscalated++; break;
      case "sent_to_agent": totalSentToAgent++; break;
    }

    if (item.round > currentRound) currentRound = item.round;

    if (item.round > 0) {
      const stat = roundMap.get(item.round) ?? { round: item.round, newCount: 0, fixedCount: 0, dismissedCount: 0 };
      switch (item.state) {
        case "new": case "sent_to_agent": stat.newCount++; break;
        case "fixed": stat.fixedCount++; break;
        case "dismissed": stat.dismissedCount++; break;
      }
      roundMap.set(item.round, stat);
    }
  }

  const issuesPerRound = Array.from(roundMap.values()).sort((a, b) => a.round - b.round);
  const lastRoundStat = issuesPerRound.at(-1);
  const isConverging = lastRoundStat != null && (lastRoundStat.fixedCount + lastRoundStat.dismissedCount) > 0;
  const canAutoAdvance = totalNew > 0 && currentRound < maxRounds;

  return {
    currentRound,
    maxRounds,
    issuesPerRound,
    totalNew,
    totalFixed,
    totalDismissed,
    totalEscalated,
    totalSentToAgent,
    isConverging,
    canAutoAdvance,
  };
}

type ConvergenceRuntimeRow = {
  pr_id: string;
  auto_converge_enabled: number;
  status: string;
  poller_status: string;
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
  return {
    prId,
    autoConvergeEnabled: state.autoConvergeEnabled,
    pathToMergeActive: state.pathToMergeActive,
    status: state.status,
    pollerStatus: state.pollerStatus,
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
// ---------------------------------------------------------------------------

export function createIssueInventoryService(deps: { db: AdeDb }) {
  const { db } = deps;

  function getAllRows(prId: string): InventoryRow[] {
    return db.all<InventoryRow>(
      "select * from pr_issue_inventory where pr_id = ? order by created_at asc",
      [prId],
    );
  }

  /**
   * Returns the highest round number found among inventory items for the given
   * PR.  Used by {@link computeEffectiveRuntime} to prevent the persisted
   * `currentRound` from regressing below what the items imply.
   */
  function getMaxItemRound(prId: string): number {
    const row = db.get<{ max_round: number | null }>(
      "select max(round) as max_round from pr_issue_inventory where pr_id = ?",
      [prId],
    );
    return row?.max_round ?? 0;
  }

  function countSentToAgentItems(prId: string, sessionId: string | null): number {
    const row = sessionId
      ? db.get<{ count: number }>(
        "select count(*) as count from pr_issue_inventory where pr_id = ? and state = 'sent_to_agent' and agent_session_id = ?",
        [prId, sessionId],
      )
      : db.get<{ count: number }>(
        "select count(*) as count from pr_issue_inventory where pr_id = ? and state = 'sent_to_agent'",
        [prId],
      );
    return row?.count ?? 0;
  }

  function clampRuntimeRoundToInventory(prId: string, now: string): void {
    db.run(
      "update pr_convergence_state set current_round = min(current_round, ?), updated_at = ? where pr_id = ?",
      [getMaxItemRound(prId), now, prId],
    );
  }

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

  /**
   * Merges a persisted (or default) runtime state with an optional patch,
   * ensuring `currentRound` never regresses below the highest round implied
   * by inventory items.  Without this floor the raw persisted value can be
   * stale when items have been ingested at a higher round but the runtime row
   * was not yet updated.
   */
  function computeEffectiveRuntime(
    persisted: ConvergenceRuntimeState,
    patch?: Partial<ConvergenceRuntimeState>,
  ): ConvergenceRuntimeState {
    const itemRound = getMaxItemRound(persisted.prId);
    const candidateRound = Math.max(
      persisted.currentRound,
      itemRound,
      patch?.currentRound ?? 0,
    );
    return {
      ...persisted,
      ...patch,
      currentRound: candidateRound,
    };
  }

  function getItemsByState(prId: string, state: IssueInventoryState): IssueInventoryItem[] {
    return db.all<InventoryRow>(
      "select * from pr_issue_inventory where pr_id = ? and state = ? order by created_at asc",
      [prId, state],
    ).map(rowToItem);
  }

  function readPipelineSettings(prId: string): PipelineSettings {
    const row = db.get<{
      auto_merge: number;
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
      `select auto_merge, merge_method, max_rounds, on_rebase_needed,
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
      autoMerge: row.auto_merge === 1,
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


  function upsertItem(
    prId: string,
    externalId: string,
    data: {
      source: IssueSource;
      type: IssueInventoryItem["type"];
      filePath: string | null;
      line: number | null;
      severity: IssueInventoryItem["severity"];
      headline: string;
      body: string | null;
      author: string | null;
      url: string | null;
      threadCommentCount?: number | null;
      threadLatestCommentId?: string | null;
      threadLatestCommentAuthor?: string | null;
      threadLatestCommentAt?: string | null;
      threadLatestCommentSource?: IssueSource | null;
    },
    options: {
      state?: IssueInventoryState;
      round?: number;
      dismissReason?: string | null;
      agentSessionId?: string | null;
    } = {},
  ): void {
    const now = nowIso();
    const existing = db.get<InventoryRow>(
      "select * from pr_issue_inventory where pr_id = ? and external_id = ?",
      [prId, externalId],
    );
    const nextState = options.state ?? existing?.state ?? "new";
    const nextRound = options.round ?? existing?.round ?? 0;
    const nextDismissReason = options.dismissReason !== undefined
      ? options.dismissReason
      : existing?.dismiss_reason ?? null;
    const nextAgentSessionId = options.agentSessionId !== undefined
      ? options.agentSessionId
      : existing?.agent_session_id ?? null;
    const nextThreadCommentCount = data.threadCommentCount ?? existing?.thread_comment_count ?? null;
    const nextThreadLatestCommentId = data.threadLatestCommentId ?? existing?.thread_latest_comment_id ?? null;
    const nextThreadLatestCommentAuthor = data.threadLatestCommentAuthor ?? existing?.thread_latest_comment_author ?? null;
    const nextThreadLatestCommentAt = data.threadLatestCommentAt ?? existing?.thread_latest_comment_at ?? null;
    const nextThreadLatestCommentSource = data.threadLatestCommentSource ?? (existing?.thread_latest_comment_source as IssueSource | null) ?? null;

    if (existing) {
      db.run(
        `update pr_issue_inventory
         set headline = ?, body = ?, severity = ?, file_path = ?, line = ?,
             author = ?, url = ?, source = ?, state = ?, round = ?, dismiss_reason = ?,
             agent_session_id = ?, thread_comment_count = ?, thread_latest_comment_id = ?,
             thread_latest_comment_author = ?, thread_latest_comment_at = ?,
             thread_latest_comment_source = ?, updated_at = ?
         where id = ?`,
        [
          data.headline,
          data.body,
          data.severity,
          data.filePath,
          data.line,
          data.author,
          data.url,
          data.source,
          nextState,
          nextRound,
          nextDismissReason,
          nextAgentSessionId,
          nextThreadCommentCount,
          nextThreadLatestCommentId,
          nextThreadLatestCommentAuthor,
          nextThreadLatestCommentAt,
          nextThreadLatestCommentSource,
          now,
          existing.id,
        ],
      );
    } else {
      db.run(
        `insert into pr_issue_inventory
           (id, pr_id, source, type, external_id, state, round, file_path, line,
            severity, headline, body, author, url, dismiss_reason, agent_session_id,
            thread_comment_count, thread_latest_comment_id, thread_latest_comment_author,
            thread_latest_comment_at, thread_latest_comment_source, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          prId,
          data.source,
          data.type,
          externalId,
          nextState,
          nextRound,
          data.filePath,
          data.line,
          data.severity,
          data.headline,
          data.body,
          data.author,
          data.url,
          nextDismissReason,
          nextAgentSessionId,
          nextThreadCommentCount,
          nextThreadLatestCommentId,
          nextThreadLatestCommentAuthor,
          nextThreadLatestCommentAt,
          nextThreadLatestCommentSource,
          now,
          now,
        ],
      );
    }
  }

  function getConvergenceRuntimeRow(prId: string): ConvergenceRuntimeRow | null {
    return db.get<ConvergenceRuntimeRow>(
      "select * from pr_convergence_state where pr_id = ?",
      [prId],
    );
  }

  function getConvergenceRuntimeRowsByActiveSessionId(sessionId: string): ConvergenceRuntimeRow[] {
    return db.all<ConvergenceRuntimeRow>(
      "select * from pr_convergence_state where active_session_id = ?",
      [sessionId],
    );
  }

  function saveConvergenceRuntimeState(prId: string, state: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState {
    validateConvergenceRuntimeState(state);
    const existing = readConvergenceRuntime(prId);
    // computeEffectiveRuntime ensures currentRound never regresses below the
    // inventory-derived round, even if the incoming patch carries a stale value.
    const effective = computeEffectiveRuntime(existing, state);
    const merged = sanitizeConvergenceRuntimeState(prId, {
      ...effective,
      prId,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });

    db.run(
      `insert into pr_convergence_state
         (pr_id, auto_converge_enabled, status, poller_status, current_round, active_session_id,
          active_lane_id, active_href, pause_reason, error_message,
          force_finalize_used, ci_retry_attempts_used, wait_for_ci_started_at,
          last_dispatch_head_sha, last_bot_ping_head_sha, last_bot_ping_at,
          pause_repeat_count, last_pause_reason_hash,
          last_started_at, last_polled_at, last_paused_at, last_stopped_at,
          created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(pr_id) do update set
         auto_converge_enabled = excluded.auto_converge_enabled,
         status = excluded.status,
         poller_status = excluded.poller_status,
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

  function buildSnapshot(prId: string): IssueInventorySnapshot {
    const items = getAllRows(prId).map(rowToItem);
    const { maxRounds } = readPipelineSettings(prId);
    const convergence = computeConvergenceStatus(items, maxRounds);
    const runtime = readConvergenceRuntime(prId);
    return {
      prId,
      items,
      convergence,
      runtime: {
        ...runtime,
        currentRound: Math.max(runtime.currentRound, convergence.currentRound),
      },
    };
  }

  return {
    syncFromPrData(
      prId: string,
      checks: PrCheck[],
      reviewThreads: PrReviewThread[],
      comments: PrComment[],
    ): IssueInventorySnapshot {
      const existingRows = getAllRows(prId);
      const existingByExternalId = new Map(existingRows.map((row) => [row.external_id, row] as const));
      const activeFailingChecks = new Set<string>();

      // Sync failing checks
      for (const check of checks) {
        if (check.conclusion !== "failure") continue;
        const externalId = `check:${check.name}`;
        activeFailingChecks.add(externalId);
        const existing = existingByExternalId.get(externalId) ?? null;
        upsertItem(prId, externalId, {
          source: "unknown",
          type: "check_failure",
          filePath: null,
          line: null,
          severity: "major",
          headline: `CI check "${check.name}" failing`,
          body: check.detailsUrl ? `Details: ${check.detailsUrl}` : null,
          author: null,
          url: check.detailsUrl,
        }, existing?.state === "fixed" ? {
          state: "new",
          round: 0,
          dismissReason: null,
          agentSessionId: null,
        } : {
          state: existing?.state as IssueInventoryState | undefined,
        });
      }

      for (const existing of existingRows) {
        if (existing.type !== "check_failure") continue;
        if (activeFailingChecks.has(existing.external_id)) continue;
        if (existing.state === "fixed" || existing.state === "dismissed") continue;
        db.run(
          "update pr_issue_inventory set state = 'fixed', updated_at = ? where id = ?",
          [nowIso(), existing.id],
        );
      }

      // Sync review threads using the latest reply in the conversation.
      for (const thread of reviewThreads) {
        const externalId = `thread:${thread.id}`;
        const latestComment = thread.comments.at(-1) ?? null;
        const commentCount = thread.comments.length;
        const author = latestComment?.author ?? null;
        const body = latestComment?.body ?? null;
        const source = detectSource(author);
        const existing = existingByExternalId.get(externalId) ?? null;

        const threadData = {
          source,
          type: "review_thread" as const,
          filePath: thread.path,
          line: thread.line,
          severity: extractSeverity(body ?? ""),
          headline: extractHeadline(body, `Review thread at ${thread.path ?? "unknown"}`),
          body,
          author,
          url: thread.url ?? latestComment?.url ?? null,
          threadCommentCount: commentCount,
          threadLatestCommentId: latestComment?.id ?? existing?.thread_latest_comment_id ?? null,
          threadLatestCommentAuthor: author,
          threadLatestCommentAt: latestComment?.updatedAt ?? latestComment?.createdAt ?? thread.updatedAt,
          threadLatestCommentSource: source,
        };

        // Only treat as a resolution ACK when the latest reply is from a real
        // human (or an unclassified author). Review bots — CodeRabbit (normalized
        // from `coderabbitai`), Copilot, Codex, Greptile, Seer, ADE, etc. — often
        // mention "fixed/resolved/done" inside long markdown bodies without
        // actually acknowledging a fix, so passing their comments through the
        // heuristic silently flips real, open threads to `"fixed"`.
        const latestReplyLooksResolved = (source === "human" || source === "unknown")
          && looksLikeResolutionAck(body);

        if (thread.isResolved || thread.isOutdated || latestReplyLooksResolved) {
          if (!existing) continue;
          upsertItem(prId, externalId, threadData, {
            state: "fixed",
            round: existing.round,
            dismissReason: null,
            agentSessionId: existing.agent_session_id,
          });
          continue;
        }

        const latestCommentAt = latestComment?.updatedAt ?? latestComment?.createdAt ?? null;
        const hasStoredThreadMetadata = existing != null
          && (
            existing.thread_latest_comment_at != null
            || existing.thread_latest_comment_id != null
            || existing.thread_comment_count != null
          );
        const threadChanged = existing != null
          && (
            hasStoredThreadMetadata
              ? (
                commentCount > (existing.thread_comment_count ?? 0)
                || (latestComment?.id != null && latestComment.id !== existing.thread_latest_comment_id)
                || (latestCommentAt != null && existing.thread_latest_comment_at != null
                    && latestCommentAt > existing.thread_latest_comment_at)
              )
              : (
                existing.body !== threadData.body
                || existing.headline !== threadData.headline
                || existing.author !== threadData.author
              )
          );
        const shouldReopen = !existing || (threadChanged && source !== "ade");

        upsertItem(prId, externalId, threadData, shouldReopen ? {
          state: "new",
          round: existing?.round ?? 0,
          dismissReason: null,
          agentSessionId: null,
        } : {
          state: existing?.state as IssueInventoryState | undefined,
          round: existing?.round,
          dismissReason: existing?.dismiss_reason,
          agentSessionId: existing?.agent_session_id,
        });
      }

      for (const comment of comments) {
        if (comment.source !== "issue") continue;
        if (isNoisyIssueComment(comment)) continue;
        const body = comment.body ?? "";
        upsertItem(prId, `comment:${comment.id}`, {
          source: detectSource(comment.author),
          type: "issue_comment",
          filePath: comment.path,
          line: comment.line,
          severity: extractSeverity(body),
          headline: extractHeadline(body, `Comment by ${comment.author}`),
          body,
          author: comment.author,
          url: comment.url,
        });
      }

      return buildSnapshot(prId);
    },

    getInventory(prId: string): IssueInventorySnapshot {
      return buildSnapshot(prId);
    },

    getNewItems(prId: string): IssueInventoryItem[] {
      return getItemsByState(prId, "new");
    },

    markSentToAgent(prId: string, itemIds: string[], sessionId: string, round: number): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          `update pr_issue_inventory
           set state = 'sent_to_agent', round = ?, agent_session_id = ?, updated_at = ?
           where id = ? and pr_id = ?`,
          [round, sessionId, now, id, prId],
        );
      }
    },

    resetSentToAgent(prId: string, options?: { sessionId?: string | null }): void {
      const sessionId = options?.sessionId?.trim() || null;
      const now = nowIso();
      if (countSentToAgentItems(prId, sessionId) === 0) return;
      if (sessionId) {
        db.run(
          `update pr_issue_inventory
           set state = 'new',
               round = case when round > 0 then round - 1 else 0 end,
               agent_session_id = null,
               updated_at = ?
           where pr_id = ? and state = 'sent_to_agent' and agent_session_id = ?`,
          [now, prId, sessionId],
        );
        clampRuntimeRoundToInventory(prId, now);
        return;
      }
      db.run(
        `update pr_issue_inventory
         set state = 'new',
             round = case when round > 0 then round - 1 else 0 end,
             agent_session_id = null,
             updated_at = ?
         where pr_id = ? and state = 'sent_to_agent'`,
        [now, prId],
      );
      clampRuntimeRoundToInventory(prId, now);
    },

    markFixed(prId: string, itemIds: string[]): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          "update pr_issue_inventory set state = 'fixed', updated_at = ? where id = ? and pr_id = ?",
          [now, id, prId],
        );
      }
    },

    markDismissed(prId: string, itemIds: string[], reason: string): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          "update pr_issue_inventory set state = 'dismissed', dismiss_reason = ?, updated_at = ? where id = ? and pr_id = ?",
          [reason, now, id, prId],
        );
      }
    },

    markEscalated(prId: string, itemIds: string[]): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          "update pr_issue_inventory set state = 'escalated', updated_at = ? where id = ? and pr_id = ?",
          [now, id, prId],
        );
      }
    },

    getConvergenceStatus(prId: string): ConvergenceStatus {
      const items = getAllRows(prId).map(rowToItem);
      const { maxRounds } = readPipelineSettings(prId);
      return computeConvergenceStatus(items, maxRounds);
    },

    resetInventory(prId: string): void {
      db.run("delete from pr_issue_inventory where pr_id = ?", [prId]);
      db.run("delete from pr_convergence_state where pr_id = ?", [prId]);
    },

    getConvergenceRuntime(prId: string): ConvergenceRuntimeState {
      return readConvergenceRuntime(prId);
    },

    saveConvergenceRuntime(prId: string, state: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState {
      return saveConvergenceRuntimeState(prId, state);
    },

    reconcileConvergenceSessionExit(sessionId: string, opts?: { exitCode?: number | null }): ConvergenceRuntimeState[] {
      const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
      if (!normalizedSessionId) return [];
      const rows = getConvergenceRuntimeRowsByActiveSessionId(normalizedSessionId);
      if (rows.length === 0) return [];
      const endedAt = nowIso();
      const exitCode = typeof opts?.exitCode === "number" ? opts.exitCode : null;
      return rows.map((row) => {
        const runtime = rowToConvergenceRuntime(row);
        if (runtime.autoConvergeEnabled) {
          return saveConvergenceRuntimeState(runtime.prId, {
            status: "paused",
            pollerStatus: "paused",
            activeSessionId: null,
            pauseReason: "Agent session ended. Refresh the PR to reconcile checks and continue.",
            errorMessage: null,
            lastPausedAt: endedAt,
          });
        }
        return saveConvergenceRuntimeState(runtime.prId, {
          status: exitCode === 0 ? "stopped" : "failed",
          pollerStatus: "stopped",
          activeSessionId: null,
          pauseReason: null,
          errorMessage: exitCode === 0
            ? null
            : `Agent session ended with exit code ${exitCode ?? "unknown"}. Refresh the PR to inspect the result.`,
          lastStoppedAt: endedAt,
        });
      });
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

    // ----- Pipeline settings (auto-converge / auto-merge) -----

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
           pr_id, auto_merge, merge_method, max_rounds, on_rebase_needed,
           conflict_strategy, force_finalize_mode,
           force_finalize_require_no_ci_failures, early_merge_on_green,
           at_cap_policy, at_cap_wait_minutes, at_cap_ci_retry_max,
           force_merge_requires_confirmation,
           auto_agent_provider, auto_agent_model, auto_agent_reasoning_effort,
           auto_agent_permission_mode, auto_agent_confidence_threshold,
           updated_at
         )
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(pr_id) do update set
           auto_merge = excluded.auto_merge,
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
          merged.autoMerge ? 1 : 0,
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
