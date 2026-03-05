import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type {
  CreateMissionArgs,
  GetMissionBudgetStatusArgs,
  MissionBudgetHardCapStatus,
  MissionBudgetPressure,
  MissionBudgetProviderSnapshot,
  MissionBudgetProviderWindow,
  MissionBudgetScopeSnapshot,
  MissionBudgetSnapshot,
  MissionPhaseBudgetSnapshot,
  MissionPreflightBudgetEstimate,
  MissionPreflightPhaseEstimate,
  MissionWorkerBudgetSnapshot,
  ModelProvider,
  PhaseCard,
} from "../../../shared/types";
import { BUILT_IN_PHASE_KEYS } from "../missions/phaseEngine";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { estimateTokenCost } from "./metricsAndUsage";
import type { createMissionService } from "../missions/missionService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import { isRecord, nowIso, parseJsonRecord } from "./orchestratorContext";

type RunRow = {
  id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type StepUsageRow = {
  step_id: string;
  step_key: string;
  title: string;
  status: string;
  metadata_json: string | null;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  models_csv: string | null;
};

type MissionRow = {
  id: string;
  metadata_json: string | null;
  started_at: string | null;
  completed_at: string | null;
};

type ClaudeProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  samples: number;
};

type ClaudWindowUsage = ClaudeProviderUsage & {
  byProvider: Record<string, ClaudeProviderUsage>;
  oldestEntryMs: number | null;
  oldestByProvider: Record<string, number>;
};

type LaunchBudgetEstimate = {
  estimate: MissionPreflightBudgetEstimate;
  hardLimitExceeded: boolean;
  windowUsageCostUsd: number | null;
  remainingWindowCostUsd: number | null;
  budgetLimitCostUsd: number | null;
};

function toNonNegativeInt(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.max(0, Math.floor(numeric));
}

function toNonNegativeNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function toBudgetScope(args: {
  usedTokens: number;
  usedTimeMs: number;
  usedCostUsd: number;
  maxTokens: number | null;
  maxTimeMs: number | null;
  maxCostUsd: number | null;
}): MissionBudgetScopeSnapshot {
  const remainingTokens = args.maxTokens != null ? Math.max(0, args.maxTokens - args.usedTokens) : null;
  const remainingTimeMs = args.maxTimeMs != null ? Math.max(0, args.maxTimeMs - args.usedTimeMs) : null;
  const remainingCostUsd = args.maxCostUsd != null ? Math.max(0, args.maxCostUsd - args.usedCostUsd) : null;
  return {
    ...(args.maxTokens != null ? { maxTokens: args.maxTokens } : {}),
    ...(args.maxTimeMs != null ? { maxTimeMs: args.maxTimeMs } : {}),
    ...(args.maxCostUsd != null ? { maxCostUsd: args.maxCostUsd } : {}),
    usedTokens: Math.max(0, Math.floor(args.usedTokens)),
    usedTimeMs: Math.max(0, Math.floor(args.usedTimeMs)),
    usedCostUsd: Math.max(0, Number(args.usedCostUsd.toFixed(6))),
    ...(remainingTokens != null ? { remainingTokens } : {}),
    ...(remainingTimeMs != null ? { remainingTimeMs } : {}),
    ...(remainingCostUsd != null ? { remainingCostUsd } : {}),
  };
}

function parseModelString(rawModel: string): { normalized: string; display: string } {
  const normalizedRaw = String(rawModel ?? "").trim();
  if (!normalizedRaw.length) {
    return {
      normalized: "anthropic/claude-sonnet-4-6",
      display: "claude-sonnet-4-6",
    };
  }
  const exact = getModelById(normalizedRaw);
  if (exact) {
    return { normalized: exact.id, display: exact.displayName };
  }
  const alias = resolveModelAlias(normalizedRaw);
  if (alias) {
    return { normalized: alias.id, display: alias.displayName };
  }
  return { normalized: normalizedRaw.toLowerCase(), display: normalizedRaw };
}

function resolvePhaseBudgetDefaults(phaseKey: string): { tokens: number; timeMs: number } {
  if (phaseKey === BUILT_IN_PHASE_KEYS.development) {
    return { tokens: 80_000, timeMs: 45 * 60_000 };
  }
  if (phaseKey === BUILT_IN_PHASE_KEYS.testing) {
    return { tokens: 24_000, timeMs: 20 * 60_000 };
  }
  if (phaseKey === BUILT_IN_PHASE_KEYS.validation) {
    return { tokens: 18_000, timeMs: 14 * 60_000 };
  }
  if (phaseKey === BUILT_IN_PHASE_KEYS.prAndConflicts) {
    return { tokens: 10_000, timeMs: 10 * 60_000 };
  }
  return { tokens: 20_000, timeMs: 15 * 60_000 };
}

function resolvePhaseFromStep(args: {
  metadataJson: string | null;
  defaultPhaseKey: string;
  availablePhaseKeys: Set<string>;
}): string {
  const metadata = parseJsonRecord(args.metadataJson);
  const explicit = typeof metadata?.phaseKey === "string" ? metadata.phaseKey.trim() : "";
  if (explicit.length > 0 && args.availablePhaseKeys.has(explicit)) return explicit;
  return args.defaultPhaseKey;
}

function toClaudometerProjectPath(projectId: string): string {
  return projectId.replace(/^-/, "/").replace(/-/g, "/");
}

function inferProviderFromModel(model: string): ModelProvider {
  const lower = (model ?? "").toLowerCase();
  if (lower.includes("codex") || lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.includes("o4")) {
    return "codex";
  }
  return "claude";
}

function emptyProviderUsage(): ClaudeProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    samples: 0,
  };
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

function readClaudeJsonlWindow(args: {
  fromMs: number;
  toMs: number;
  projectRoot: string | null;
  logger: Logger;
}): ClaudWindowUsage {
  const emptyResult = (): ClaudWindowUsage => ({
    ...emptyProviderUsage(),
    byProvider: {},
    oldestEntryMs: null,
    oldestByProvider: {},
  });

  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeProjectsDir)) {
    return emptyResult();
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let samples = 0;
  let oldestEntryMs: number | null = null;
  const oldestByProvider: Record<string, number> = {};
  const byProvider: Record<string, ClaudeProviderUsage> = {};

  const projectRoot = args.projectRoot ? path.resolve(args.projectRoot) : null;
  const projectEntries = fs.readdirSync(claudeProjectsDir);
  for (const projectEntry of projectEntries) {
    const projectPath = path.join(claudeProjectsDir, projectEntry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(projectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const decodedProjectPath = toClaudometerProjectPath(projectEntry);
    if (projectRoot) {
      const normalizedDecoded = path.resolve(decodedProjectPath);
      if (!normalizedDecoded.includes(path.basename(projectRoot)) && !projectRoot.includes(path.basename(normalizedDecoded))) {
        continue;
      }
    }

    let files: string[] = [];
    try {
      files = fs.readdirSync(projectPath).filter((entry) => entry.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const fileName of files) {
      const filePath = path.join(projectPath, fileName);
      try {
        const mtimeMs = fs.statSync(filePath).mtimeMs;
        if (mtimeMs < args.fromMs - (24 * 60 * 60 * 1000)) continue;
        const text = fs.readFileSync(filePath, "utf8");
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.length) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed) as unknown;
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;
          const timestampRaw =
            (typeof parsed.timestamp === "string" && parsed.timestamp)
            || (typeof parsed.createdAt === "string" && parsed.createdAt)
            || null;
          if (!timestampRaw) continue;
          const timestampMs = Date.parse(timestampRaw);
          if (!Number.isFinite(timestampMs)) continue;
          if (timestampMs < args.fromMs || timestampMs > args.toMs) continue;

          if (projectRoot) {
            const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
            if (!cwd) continue;
            const normalizedCwd = path.resolve(cwd);
            if (!normalizedCwd.startsWith(projectRoot)) continue;
          }

          const message = isRecord(parsed.message) ? parsed.message : null;
          const usage = isRecord(parsed.usage)
            ? parsed.usage
            : message && isRecord(message.usage)
              ? message.usage
              : null;
          if (!usage) continue;

          const inTokens = Number(usage.input_tokens ?? 0);
          const outTokens = Number(usage.output_tokens ?? 0);
          const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
          const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
          if (!Number.isFinite(inTokens) || !Number.isFinite(outTokens) || !Number.isFinite(cacheRead) || !Number.isFinite(cacheWrite)) {
            continue;
          }
          const safeIn = Math.max(0, Math.floor(inTokens));
          const safeOut = Math.max(0, Math.floor(outTokens));
          const safeCacheRead = Math.max(0, Math.floor(cacheRead));
          const safeCacheWrite = Math.max(0, Math.floor(cacheWrite));

          inputTokens += safeIn;
          outputTokens += safeOut;
          cacheReadTokens += safeCacheRead;
          cacheWriteTokens += safeCacheWrite;

          const model = typeof message?.model === "string"
            ? message.model
            : typeof parsed.model === "string"
              ? parsed.model
              : "claude-sonnet-4-6";
          const entryCost = estimateTokenCost(model, inTokens, outTokens);
          costUsd += entryCost;
          samples += 1;

          // Track oldest entry timestamp for time-until-reset calculations
          if (oldestEntryMs === null || timestampMs < oldestEntryMs) {
            oldestEntryMs = timestampMs;
          }

          const provider = inferProviderFromModel(model);

          if (!(provider in oldestByProvider) || timestampMs < oldestByProvider[provider]) {
            oldestByProvider[provider] = timestampMs;
          }

          const bucket = byProvider[provider] ?? (byProvider[provider] = emptyProviderUsage());
          bucket.inputTokens += safeIn;
          bucket.outputTokens += safeOut;
          bucket.cacheReadTokens += safeCacheRead;
          bucket.cacheWriteTokens += safeCacheWrite;
          bucket.totalTokens += safeIn + safeOut + safeCacheRead + safeCacheWrite;
          bucket.costUsd += entryCost;
          bucket.samples += 1;
        }
      } catch (error) {
        args.logger.debug("mission_budget.read_claude_jsonl_failed", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Round cost values
  for (const bucket of Object.values(byProvider)) {
    bucket.costUsd = Number(bucket.costUsd.toFixed(6));
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    costUsd: Number(costUsd.toFixed(6)),
    samples,
    byProvider,
    oldestEntryMs,
    oldestByProvider,
  };
}

function computePressure(scope: MissionBudgetScopeSnapshot): MissionBudgetPressure {
  const ratios: number[] = [];
  if (typeof scope.maxTokens === "number" && scope.maxTokens > 0) {
    ratios.push(scope.usedTokens / scope.maxTokens);
  }
  if (typeof scope.maxTimeMs === "number" && scope.maxTimeMs > 0) {
    ratios.push(scope.usedTimeMs / scope.maxTimeMs);
  }
  if (typeof scope.maxCostUsd === "number" && scope.maxCostUsd > 0) {
    ratios.push(scope.usedCostUsd / scope.maxCostUsd);
  }
  if (ratios.length === 0) return "normal";
  const maxRatio = Math.max(...ratios);
  if (maxRatio >= 0.85) return "critical";
  if (maxRatio >= 0.6) return "warning";
  return "normal";
}

function pressureRecommendation(pressure: MissionBudgetPressure): string {
  if (pressure === "critical") {
    return "Critical pressure: run one worker at a time, finish the current milestone, and defer optional work.";
  }
  if (pressure === "warning") {
    return "Warning pressure: reduce parallelism, prefer cheaper models, and defer optional validation.";
  }
  return "Budget healthy: continue current strategy.";
}

export function createMissionBudgetService(args: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  missionService: ReturnType<typeof createMissionService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService> | null;
}) {
  const {
    db,
    logger,
    projectId,
    projectRoot,
    missionService,
    aiIntegrationService,
  } = args;

  const resolveBudgetMode = async (): Promise<"subscription" | "api-key"> => {
    if (!aiIntegrationService) return "api-key";
    try {
      const status = await aiIntegrationService.getStatus();
      const hasSubscriptionCli = (status.detectedAuth ?? []).some(
        (entry) => entry.type === "cli-subscription" && entry.authenticated !== false,
      );
      if (status.mode === "subscription" && hasSubscriptionCli) return "subscription";
      return "api-key";
    } catch {
      return "api-key";
    }
  };

  const estimateLaunchBudget = async (args: {
    launch: CreateMissionArgs;
    selectedPhases: PhaseCard[];
  }): Promise<LaunchBudgetEstimate> => {
    const mode = await resolveBudgetMode();
    const perPhase: MissionPreflightPhaseEstimate[] = [];

    let totalTokens = 0;
    let totalTimeMs = 0;
    let totalCostUsd = 0;
    let hasTokenEstimate = false;
    let hasTimeEstimate = false;

    for (const phase of args.selectedPhases) {
      const defaults = resolvePhaseBudgetDefaults(phase.phaseKey);
      const configuredTokens = toNonNegativeInt(phase.budget.maxTokens);
      const configuredTimeMs = toNonNegativeInt(phase.budget.maxTimeMs);
      const estimatedTokens = configuredTokens ?? defaults.tokens;
      const estimatedTimeMs = configuredTimeMs ?? defaults.timeMs;
      const model = parseModelString(phase.model.modelId).normalized;
      const estimatedCostUsd = estimateTokenCost(model, Math.floor(estimatedTokens * 0.6), Math.floor(estimatedTokens * 0.4));

      totalTokens += estimatedTokens;
      totalTimeMs += estimatedTimeMs;
      totalCostUsd += estimatedCostUsd;
      hasTokenEstimate = true;
      hasTimeEstimate = true;

      perPhase.push({
        phaseKey: phase.phaseKey,
        phaseName: phase.name,
        estimatedTokens,
        estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
        estimatedTimeMs,
        configuredMaxTokens: configuredTokens,
        configuredMaxTimeMs: configuredTimeMs,
      });
    }

    const smartBudget = args.launch.modelConfig?.smartBudget;
    const budgetLimitCostUsd = smartBudget?.enabled === true
      ? toNonNegativeNumber(smartBudget.fiveHourThresholdUsd) ?? null
      : null;

    let windowUsageCostUsd: number | null = null;
    let remainingWindowCostUsd: number | null = null;
    if (budgetLimitCostUsd != null) {
      const nowMs = Date.now();
      const fiveHoursAgo = nowMs - FIVE_HOUR_MS;
      const usage = readClaudeJsonlWindow({
        fromMs: fiveHoursAgo,
        toMs: nowMs,
        projectRoot: null,
        logger,
      });
      windowUsageCostUsd = usage.costUsd;
      remainingWindowCostUsd = Math.max(0, budgetLimitCostUsd - usage.costUsd);
    }

    const hardLimitExceeded = mode === "api-key"
      && remainingWindowCostUsd != null
      && totalCostUsd > remainingWindowCostUsd;

    const estimate: MissionPreflightBudgetEstimate = {
      mode,
      estimatedTokens: hasTokenEstimate ? totalTokens : null,
      estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
      estimatedTimeMs: hasTimeEstimate ? totalTimeMs : null,
      perPhase,
      ...(remainingWindowCostUsd != null
        ? {
            note: `Estimated remaining 5-hour capacity: ~$${remainingWindowCostUsd.toFixed(2)} (based on local ~/.claude session usage).`,
          }
        : mode === "subscription"
          ? {
              note: "Subscription mode uses local CLI session telemetry for best-effort estimates.",
            }
          : {}),
    };

    return {
      estimate,
      hardLimitExceeded,
      windowUsageCostUsd,
      remainingWindowCostUsd,
      budgetLimitCostUsd,
    };
  };

  const getMissionBudgetStatus = async (
    budgetArgs: GetMissionBudgetStatusArgs,
  ): Promise<MissionBudgetSnapshot> => {
    const missionId = String(budgetArgs.missionId ?? "").trim();
    if (!missionId.length) throw new Error("missionId is required.");
    const mission = missionService.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const missionRow = db.get<MissionRow>(
      `
        select id, metadata_json, started_at, completed_at
        from missions
        where id = ?
          and project_id = ?
        limit 1
      `,
      [missionId, projectId],
    );
    if (!missionRow) throw new Error(`Mission not found: ${missionId}`);

    const runIdFilter = typeof budgetArgs.runId === "string" && budgetArgs.runId.trim().length > 0
      ? budgetArgs.runId.trim()
      : null;
    const runRow = db.get<RunRow>(
      `
        select id, status, created_at, started_at, completed_at
        from orchestrator_runs
        where mission_id = ?
          and project_id = ?
          and (? is null or id = ?)
        order by created_at desc
        limit 1
      `,
      [missionId, projectId, runIdFilter, runIdFilter],
    );

    const phaseConfiguration = missionService.getPhaseConfiguration(missionId);
    const selectedPhases = phaseConfiguration?.selectedPhases ?? [];
    const phaseByKey = new Map(selectedPhases.map((phase) => [phase.phaseKey, phase] as const));
    const phaseKeySet = new Set<string>(selectedPhases.map((phase) => phase.phaseKey));
    const fallbackPhaseKey = selectedPhases[0]?.phaseKey ?? BUILT_IN_PHASE_KEYS.development;

    const stepRows: StepUsageRow[] = runRow
      ? db.all<StepUsageRow>(
          `
            select
              s.id as step_id,
              s.step_key,
              s.title,
              s.status,
              s.metadata_json,
              coalesce(sum(u.input_tokens), 0) as input_tokens,
              coalesce(sum(u.output_tokens), 0) as output_tokens,
              coalesce(sum(u.duration_ms), 0) as duration_ms,
              group_concat(distinct u.model) as models_csv
            from orchestrator_steps s
            left join orchestrator_attempts a
              on a.project_id = s.project_id
              and a.step_id = s.id
            left join ai_usage_log u
              on u.session_id = a.executor_session_id
            where s.project_id = ?
              and s.run_id = ?
            group by s.id, s.step_key, s.title, s.status, s.metadata_json
            order by s.step_index asc, s.created_at asc
          `,
          [projectId, runRow.id],
        )
      : [];

    const mode = await resolveBudgetMode();
    const metadata = parseJsonRecord(missionRow.metadata_json);
    const launchMeta = metadata && isRecord(metadata.launch) ? metadata.launch : null;
    const modelConfig = launchMeta && isRecord(launchMeta.modelConfig) ? launchMeta.modelConfig : null;
    const smartBudget = modelConfig && isRecord(modelConfig.smartBudget) ? modelConfig.smartBudget : null;
    const configuredMaxCostUsd = smartBudget?.enabled === true
      ? toNonNegativeNumber(smartBudget.fiveHourThresholdUsd) ?? null
      : null;

    const configuredMaxTokens = (() => {
      const values = selectedPhases
        .map((phase) => toNonNegativeInt(phase.budget.maxTokens))
        .filter((value): value is number => value != null);
      if (!values.length) return null;
      return values.reduce((sum, value) => sum + value, 0);
    })();
    const configuredMaxTimeMs = (() => {
      const values = selectedPhases
        .map((phase) => toNonNegativeInt(phase.budget.maxTimeMs))
        .filter((value): value is number => value != null);
      if (!values.length) return null;
      return values.reduce((sum, value) => sum + value, 0);
    })();

    const perWorker: MissionWorkerBudgetSnapshot[] = [];
    const perPhaseMap = new Map<string, {
      phaseName: string;
      stepCount: number;
      usedTokens: number;
      usedTimeMs: number;
      usedCostUsd: number;
      maxTokens: number | null;
      maxTimeMs: number | null;
    }>();

    for (const phase of selectedPhases) {
      perPhaseMap.set(phase.phaseKey, {
        phaseName: phase.name,
        stepCount: 0,
        usedTokens: 0,
        usedTimeMs: 0,
        usedCostUsd: 0,
        maxTokens: toNonNegativeInt(phase.budget.maxTokens),
        maxTimeMs: toNonNegativeInt(phase.budget.maxTimeMs),
      });
    }

    let activeWorkers = 0;
    for (const row of stepRows) {
      const phaseKey = resolvePhaseFromStep({
        metadataJson: row.metadata_json,
        defaultPhaseKey: fallbackPhaseKey,
        availablePhaseKeys: phaseKeySet,
      });
      const phase = phaseByKey.get(phaseKey);
      const phaseName = phase?.name ?? phaseKey;
      const inputTokens = Math.max(0, Math.floor(Number(row.input_tokens ?? 0)));
      const outputTokens = Math.max(0, Math.floor(Number(row.output_tokens ?? 0)));
      const totalTokens = inputTokens + outputTokens;
      const usedTimeMs = Math.max(0, Math.floor(Number(row.duration_ms ?? 0)));
      const models = (row.models_csv ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const model = models[0] ?? phase?.model.modelId ?? "anthropic/claude-sonnet-4-6";
      const usedCostUsd = estimateTokenCost(model, inputTokens, outputTokens);

      if (row.status === "running") activeWorkers += 1;

      if (totalTokens > 0 || usedTimeMs > 0 || usedCostUsd > 0 || row.status === "running") {
        perWorker.push({
          stepId: row.step_id,
          stepKey: row.step_key,
          title: row.title,
          phaseKey,
          phaseName,
          ...toBudgetScope({
            usedTokens: totalTokens,
            usedTimeMs,
            usedCostUsd,
            maxTokens: toNonNegativeInt(phase?.budget.maxTokens),
            maxTimeMs: toNonNegativeInt(phase?.budget.maxTimeMs),
            maxCostUsd: null,
          }),
        });
      }

      const aggregate = perPhaseMap.get(phaseKey) ?? {
        phaseName,
        stepCount: 0,
        usedTokens: 0,
        usedTimeMs: 0,
        usedCostUsd: 0,
        maxTokens: null,
        maxTimeMs: null,
      };
      aggregate.stepCount += 1;
      aggregate.usedTokens += totalTokens;
      aggregate.usedTimeMs += usedTimeMs;
      aggregate.usedCostUsd += usedCostUsd;
      perPhaseMap.set(phaseKey, aggregate);
    }

    const perPhase: MissionPhaseBudgetSnapshot[] = [...perPhaseMap.entries()]
      .map(([phaseKey, aggregate]) => ({
        phaseKey,
        phaseName: aggregate.phaseName,
        stepCount: aggregate.stepCount,
        ...toBudgetScope({
          usedTokens: aggregate.usedTokens,
          usedTimeMs: aggregate.usedTimeMs,
          usedCostUsd: aggregate.usedCostUsd,
          maxTokens: aggregate.maxTokens,
          maxTimeMs: aggregate.maxTimeMs,
          maxCostUsd: null,
        }),
      }))
      .sort((a, b) => a.phaseName.localeCompare(b.phaseName));

    let missionUsedTokens = perPhase.reduce((sum, phase) => sum + phase.usedTokens, 0);
    let missionUsedTimeMs = perPhase.reduce((sum, phase) => sum + phase.usedTimeMs, 0);
    let missionUsedCostUsd = perPhase.reduce((sum, phase) => sum + phase.usedCostUsd, 0);

    const runStart = Date.parse(runRow?.started_at ?? missionRow.started_at ?? missionRow.completed_at ?? nowIso());
    const runEnd = Date.parse(runRow?.completed_at ?? missionRow.completed_at ?? nowIso());
    const claudeScopedUsage = mode === "subscription" && Number.isFinite(runStart) && Number.isFinite(runEnd)
      ? readClaudeJsonlWindow({
          fromMs: runStart,
          toMs: runEnd,
          projectRoot,
          logger,
        })
      : null;

    const dataSources = ["ai_usage_log", "orchestrator_attempts"];
    if (claudeScopedUsage && claudeScopedUsage.samples > 0) {
      if (missionUsedTokens === 0) {
        missionUsedTokens = claudeScopedUsage.totalTokens;
      }
      if (missionUsedCostUsd === 0) {
        missionUsedCostUsd = claudeScopedUsage.costUsd;
      }
      dataSources.push("~/.claude/projects/*.jsonl");
    }

    if (missionUsedTimeMs === 0 && runRow?.started_at) {
      const startedMs = Date.parse(runRow.started_at);
      const completedMs = runRow.completed_at ? Date.parse(runRow.completed_at) : Date.now();
      if (Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs) {
        missionUsedTimeMs = Math.max(0, Math.floor(completedMs - startedMs));
      }
    }

    const missionScope = toBudgetScope({
      usedTokens: missionUsedTokens,
      usedTimeMs: missionUsedTimeMs,
      usedCostUsd: missionUsedCostUsd,
      maxTokens: configuredMaxTokens,
      maxTimeMs: configuredMaxTimeMs,
      maxCostUsd: configuredMaxCostUsd,
    });

    // ── Per-provider window usage ────────────────────────────────
    const nowMs = Date.now();
    const fiveHourUsage = readClaudeJsonlWindow({
      fromMs: nowMs - FIVE_HOUR_MS,
      toMs: nowMs,
      projectRoot: null,
      logger,
    });
    const weeklyUsage = readClaudeJsonlWindow({
      fromMs: nowMs - WEEKLY_MS,
      toMs: nowMs,
      projectRoot: null,
      logger,
    });

    if (fiveHourUsage.samples > 0 || weeklyUsage.samples > 0) {
      if (!dataSources.includes("~/.claude/projects/*.jsonl")) {
        dataSources.push("~/.claude/projects/*.jsonl");
      }
    }

    const providerLimits = smartBudget && isRecord(smartBudget.providerLimits)
      ? smartBudget.providerLimits as Record<string, unknown>
      : null;

    // Collect providers used in this mission (from step rows + JSONL windows)
    const missionProviders = new Set<string>();
    for (const row of stepRows) {
      const models = (row.models_csv ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      for (const m of models) {
        missionProviders.add(inferProviderFromModel(m));
      }
    }
    for (const p of Object.keys(fiveHourUsage.byProvider)) missionProviders.add(p);
    for (const p of Object.keys(weeklyUsage.byProvider)) missionProviders.add(p);
    // Ensure at least the orchestrator model's provider is present
    const orchestratorModelId = modelConfig && isRecord(modelConfig.orchestratorModel) && typeof (modelConfig.orchestratorModel as Record<string, unknown>).modelId === "string"
      ? (modelConfig.orchestratorModel as Record<string, unknown>).modelId as string
      : "anthropic/claude-sonnet-4-6";
    missionProviders.add(inferProviderFromModel(orchestratorModelId));

    const fiveHourHardStopPercent = smartBudget && typeof smartBudget.fiveHourHardStopPercent === "number"
      ? smartBudget.fiveHourHardStopPercent
      : null;
    const weeklyHardStopPercent = smartBudget && typeof smartBudget.weeklyHardStopPercent === "number"
      ? smartBudget.weeklyHardStopPercent
      : null;
    const apiKeyMaxSpendUsd = smartBudget && typeof smartBudget.apiKeyMaxSpendUsd === "number"
      ? smartBudget.apiKeyMaxSpendUsd
      : null;

    let fiveHourTriggered = false;
    let weeklyTriggered = false;
    let apiKeyTriggered = false;

    const perProvider: MissionBudgetProviderSnapshot[] = [...missionProviders].sort().map((provider) => {
      const fiveHrBucket = fiveHourUsage.byProvider[provider] ?? emptyProviderUsage();
      const weeklyBucket = weeklyUsage.byProvider[provider] ?? emptyProviderUsage();

      const limits = providerLimits && isRecord(providerLimits[provider])
        ? providerLimits[provider] as Record<string, unknown>
        : null;
      const fiveHourTokenLimit = limits && typeof limits.fiveHourTokenLimit === "number"
        ? limits.fiveHourTokenLimit
        : null;
      const weeklyTokenLimit = limits && typeof limits.weeklyTokenLimit === "number"
        ? limits.weeklyTokenLimit
        : null;

      const fiveHrPct = fiveHourTokenLimit != null && fiveHourTokenLimit > 0
        ? Number(((fiveHrBucket.totalTokens / fiveHourTokenLimit) * 100).toFixed(1))
        : null;
      const weeklyPct = weeklyTokenLimit != null && weeklyTokenLimit > 0
        ? Number(((weeklyBucket.totalTokens / weeklyTokenLimit) * 100).toFixed(1))
        : null;

      // Check hard caps per provider
      if (fiveHourHardStopPercent != null && fiveHrPct != null && fiveHrPct >= fiveHourHardStopPercent) {
        fiveHourTriggered = true;
      }
      if (weeklyHardStopPercent != null && weeklyPct != null && weeklyPct >= weeklyHardStopPercent) {
        weeklyTriggered = true;
      }

      // Time until the oldest entry in this provider's window "falls off" the sliding window.
      // The oldest entry leaves the window at (oldestEntryTimestamp + windowDuration),
      // so timeUntilReset = (oldestEntryTimestamp + windowDuration) - now.
      const fiveHrOldest = fiveHourUsage.oldestByProvider[provider] ?? null;
      const timeUntilFiveHrReset = fiveHrBucket.samples > 0 && fiveHrOldest != null
        ? Math.max(0, (fiveHrOldest + FIVE_HOUR_MS) - nowMs)
        : null;

      const weeklyOldest = weeklyUsage.oldestByProvider[provider] ?? null;
      const timeUntilWeeklyReset = weeklyBucket.samples > 0 && weeklyOldest != null
        ? Math.max(0, (weeklyOldest + WEEKLY_MS) - nowMs)
        : null;

      const fiveHour: MissionBudgetProviderWindow = {
        usedTokens: fiveHrBucket.totalTokens,
        limitTokens: fiveHourTokenLimit,
        usedPct: fiveHrPct,
        usedCostUsd: fiveHrBucket.costUsd,
        timeUntilResetMs: timeUntilFiveHrReset,
      };
      const weekly: MissionBudgetProviderWindow = {
        usedTokens: weeklyBucket.totalTokens,
        limitTokens: weeklyTokenLimit,
        usedPct: weeklyPct,
        usedCostUsd: weeklyBucket.costUsd,
        timeUntilResetMs: timeUntilWeeklyReset,
      };

      return { provider, fiveHour, weekly };
    });

    // API key hard cap check
    if (apiKeyMaxSpendUsd != null && mode === "api-key" && missionUsedCostUsd >= apiKeyMaxSpendUsd) {
      apiKeyTriggered = true;
    }

    const hardCaps: MissionBudgetHardCapStatus = {
      fiveHourHardStopPercent: typeof fiveHourHardStopPercent === "number" ? fiveHourHardStopPercent : null,
      weeklyHardStopPercent: typeof weeklyHardStopPercent === "number" ? weeklyHardStopPercent : null,
      apiKeyMaxSpendUsd: typeof apiKeyMaxSpendUsd === "number" ? apiKeyMaxSpendUsd : null,
      apiKeySpentUsd: mode === "api-key" ? missionUsedCostUsd : 0,
      fiveHourTriggered,
      weeklyTriggered,
      apiKeyTriggered,
    };

    const pressure = computePressure(missionScope);
    const terminalStatuses = new Set(["succeeded", "failed", "blocked", "canceled", "skipped", "superseded"]);
    const completedWorkers = stepRows.filter((row) => terminalStatuses.has(row.status)).length;
    const avgTokensPerStep = completedWorkers > 0 ? missionScope.usedTokens / completedWorkers : 0;
    const avgTimePerStep = completedWorkers > 0 ? missionScope.usedTimeMs / completedWorkers : 0;
    const remainingStepsEstimate =
      avgTokensPerStep > 0 && typeof missionScope.remainingTokens === "number"
        ? Math.max(0, Math.floor(missionScope.remainingTokens / avgTokensPerStep))
        : null;
    const remainingDurationEstimate =
      remainingStepsEstimate != null && avgTimePerStep > 0
        ? Math.max(0, Math.floor(remainingStepsEstimate * avgTimePerStep))
        : null;

    return {
      missionId,
      runId: runRow?.id ?? null,
      computedAt: nowIso(),
      mode,
      pressure,
      mission: missionScope,
      perPhase,
      perWorker: perWorker.sort((a, b) => b.usedTokens - a.usedTokens),
      perProvider,
      hardCaps,
      activeWorkers,
      recommendation: pressureRecommendation(pressure),
      estimatedRemainingCapacity: {
        steps: remainingStepsEstimate,
        durationMs: remainingDurationEstimate,
      },
      rateLimits: [],
      dataSources,
    };
  };

  return {
    estimateLaunchBudget,
    getMissionBudgetStatus,
  };
}

export type MissionBudgetService = ReturnType<typeof createMissionBudgetService>;
