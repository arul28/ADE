import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type {
  CreateMissionArgs,
  GetMissionBudgetTelemetryArgs,
  GetMissionBudgetStatusArgs,
  MissionBudgetHardCapStatus,
  MissionBudgetForecast,
  MissionBudgetPressure,
  MissionBudgetProviderSnapshot,
  MissionBudgetProviderWindow,
  MissionBudgetScopeSnapshot,
  MissionBudgetSnapshot,
  MissionBudgetTelemetrySnapshot,
  MissionPhaseBudgetSnapshot,
  MissionPreflightBudgetEstimate,
  MissionPreflightPhaseEstimate,
  MissionWorkerBudgetSnapshot,
  ModelProvider,
  PhaseCard,
} from "../../../shared/types";
import { BUILT_IN_PHASE_KEYS } from "../missions/phaseEngine";
import { getModelById, resolveModelAlias, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { estimateTokenCost } from "./metricsAndUsage";
import type { createMissionService } from "../missions/missionService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
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

type ExternalMcpCostRow = {
  step_id: string | null;
  total_cost_cents: number;
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

function roundCost(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(6));
}

function roundDuration(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function buildForecastFromEstimate(args: {
  estimatedCostUsd: number | null;
  estimatedTimeMs: number | null;
  sampleSize: number;
  basis: string;
}): MissionBudgetForecast | null {
  const hasCost = args.estimatedCostUsd != null && Number.isFinite(args.estimatedCostUsd);
  const hasTime = args.estimatedTimeMs != null && Number.isFinite(args.estimatedTimeMs);
  if (!hasCost && !hasTime) return null;
  const medianCost = hasCost ? Math.max(0, args.estimatedCostUsd ?? 0) : null;
  const medianDuration = hasTime ? Math.max(0, args.estimatedTimeMs ?? 0) : null;
  const varianceLow = args.sampleSize >= 3 ? 0.8 : 0.65;
  const varianceHigh = args.sampleSize >= 3 ? 1.3 : 1.55;
  return {
    lowCostUsd: medianCost != null ? roundCost(medianCost * varianceLow) : null,
    medianCostUsd: medianCost != null ? roundCost(medianCost) : null,
    highCostUsd: medianCost != null ? roundCost(medianCost * varianceHigh) : null,
    lowDurationMs: medianDuration != null ? roundDuration(medianDuration * varianceLow) : null,
    medianDurationMs: medianDuration != null ? roundDuration(medianDuration) : null,
    highDurationMs: medianDuration != null ? roundDuration(medianDuration * varianceHigh) : null,
    confidence: clampConfidence(0.3 + Math.min(0.45, args.sampleSize / 12)),
    sampleSize: Math.max(0, args.sampleSize),
    basis: args.basis,
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

function mapFamilyToSubscriptionProvider(family: string): "claude" | "codex" | null {
  if (family === "anthropic") return "claude";
  if (family === "openai") return "codex";
  return null;
}

function resolveModelBudgetPath(modelRef: string): {
  subscriptionProvider: "claude" | "codex" | null;
  apiMetered: boolean;
} {
  const normalized = parseModelString(modelRef).normalized;
  const descriptor = resolveModelDescriptor(normalized) ?? resolveModelDescriptor(modelRef);
  if (!descriptor) {
    return {
      subscriptionProvider: null,
      apiMetered: true,
    };
  }
  const subscriptionProvider = descriptor.isCliWrapped
    ? mapFamilyToSubscriptionProvider(descriptor.family)
    : null;
  const apiMetered =
    descriptor.authTypes.includes("api-key")
    || descriptor.authTypes.includes("openrouter");
  return {
    subscriptionProvider,
    apiMetered,
  };
}

function collectModelBudgetPaths(args: {
  selectedPhases: PhaseCard[];
  orchestratorModelId: string | null;
}): {
  subscriptionProviders: Set<"claude" | "codex">;
  hasApiModels: boolean;
} {
  const subscriptionProviders = new Set<"claude" | "codex">();
  let hasApiModels = false;
  const pushModel = (raw: string | null | undefined): void => {
    const modelId = String(raw ?? "").trim();
    if (!modelId.length) return;
    const path = resolveModelBudgetPath(modelId);
    if (path.subscriptionProvider) {
      subscriptionProviders.add(path.subscriptionProvider);
    }
    if (path.apiMetered) {
      hasApiModels = true;
    }
  };
  for (const phase of args.selectedPhases) {
    pushModel(phase.model.modelId);
  }
  pushModel(args.orchestratorModelId);
  return { subscriptionProviders, hasApiModels };
}

function isPathWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  if (normalizedCandidate === normalizedRoot) return true;
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function mergeWindowUsage(parts: ClaudWindowUsage[]): ClaudWindowUsage {
  const merged: ClaudWindowUsage = {
    ...emptyProviderUsage(),
    byProvider: {},
    oldestEntryMs: null,
    oldestByProvider: {},
  };
  for (const part of parts) {
    merged.inputTokens += part.inputTokens;
    merged.outputTokens += part.outputTokens;
    merged.cacheReadTokens += part.cacheReadTokens;
    merged.cacheWriteTokens += part.cacheWriteTokens;
    merged.totalTokens += part.totalTokens;
    merged.costUsd += part.costUsd;
    merged.samples += part.samples;
    if (part.oldestEntryMs != null && (merged.oldestEntryMs == null || part.oldestEntryMs < merged.oldestEntryMs)) {
      merged.oldestEntryMs = part.oldestEntryMs;
    }
    for (const [provider, oldest] of Object.entries(part.oldestByProvider)) {
      if (!(provider in merged.oldestByProvider) || oldest < merged.oldestByProvider[provider]!) {
        merged.oldestByProvider[provider] = oldest;
      }
    }
    for (const [provider, bucket] of Object.entries(part.byProvider)) {
      const target = merged.byProvider[provider] ?? (merged.byProvider[provider] = emptyProviderUsage());
      target.inputTokens += bucket.inputTokens;
      target.outputTokens += bucket.outputTokens;
      target.cacheReadTokens += bucket.cacheReadTokens;
      target.cacheWriteTokens += bucket.cacheWriteTokens;
      target.totalTokens += bucket.totalTokens;
      target.costUsd += bucket.costUsd;
      target.samples += bucket.samples;
    }
  }
  merged.costUsd = Number(merged.costUsd.toFixed(6));
  for (const bucket of Object.values(merged.byProvider)) {
    bucket.costUsd = Number(bucket.costUsd.toFixed(6));
  }
  return merged;
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
  claudeProjectsRoot?: string | null;
  logger: Logger;
}): ClaudWindowUsage {
  const emptyResult = (): ClaudWindowUsage => ({
    ...emptyProviderUsage(),
    byProvider: {},
    oldestEntryMs: null,
    oldestByProvider: {},
  });

  const configuredRoot = typeof args.claudeProjectsRoot === "string" ? args.claudeProjectsRoot.trim() : "";
  const claudeProjectsDir = configuredRoot.length > 0
    ? path.resolve(configuredRoot)
    : path.join(os.homedir(), ".claude", "projects");
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

function readCodexJsonlWindow(args: {
  fromMs: number;
  toMs: number;
  projectRoot: string | null;
  codexSessionsRoot?: string | null;
  logger: Logger;
}): ClaudWindowUsage {
  const emptyResult = (): ClaudWindowUsage => ({
    ...emptyProviderUsage(),
    byProvider: {},
    oldestEntryMs: null,
    oldestByProvider: {},
  });

  const configuredRoot = typeof args.codexSessionsRoot === "string" ? args.codexSessionsRoot.trim() : "";
  const sessionsRoot = configuredRoot.length > 0
    ? path.resolve(configuredRoot)
    : path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsRoot)) return emptyResult();

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
  const files: string[] = [];
  const minMtimeMs = args.fromMs - (24 * 60 * 60 * 1000);
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(abs);
        if (stat.mtimeMs < minMtimeMs) continue;
      } catch {
        continue;
      }
      files.push(abs);
    }
  }

  for (const filePath of files) {
    try {
      const text = fs.readFileSync(filePath, "utf8");
      const lines = text.split("\n");
      let currentModel = "";
      let sessionCwd = "";
      let prevTotal: { input: number; output: number; cached: number; reasoning: number; total: number } | null = null;
      let lastUsageEventKey = "";

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

        const recordType = typeof parsed.type === "string" ? parsed.type : "";
        const payload = isRecord(parsed.payload) ? parsed.payload : null;
        if (recordType === "session_meta" && payload && typeof payload.cwd === "string") {
          sessionCwd = payload.cwd;
        }
        if (recordType === "turn_context" && payload && typeof payload.model === "string") {
          currentModel = payload.model.trim();
          if (typeof payload.cwd === "string" && payload.cwd.trim().length > 0) {
            sessionCwd = payload.cwd.trim();
          }
        }

        if (recordType !== "event_msg" || !payload || payload.type !== "token_count") continue;

        const info = isRecord(payload.info) ? payload.info : null;
        if (!info) continue;
        const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : null;
        const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : null;

        const toUsageNumbers = (source: Record<string, unknown> | null) => {
          const input = Number(source?.input_tokens ?? 0);
          const output = Number(source?.output_tokens ?? 0);
          const cached = Number(source?.cached_input_tokens ?? 0);
          const reasoning = Number(source?.reasoning_output_tokens ?? 0);
          const total = Number(source?.total_tokens ?? (input + output + cached + reasoning));
          return {
            input: Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0,
            output: Number.isFinite(output) ? Math.max(0, Math.floor(output)) : 0,
            cached: Number.isFinite(cached) ? Math.max(0, Math.floor(cached)) : 0,
            reasoning: Number.isFinite(reasoning) ? Math.max(0, Math.floor(reasoning)) : 0,
            total: Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0,
          };
        };

        const totalNow = toUsageNumbers(totalUsage);
        const lastNow = toUsageNumbers(lastUsage);
        const eventKey = `${timestampMs}:${totalNow.input}:${totalNow.output}:${totalNow.cached}:${totalNow.reasoning}:${totalNow.total}:${lastNow.input}:${lastNow.output}:${lastNow.cached}:${lastNow.reasoning}:${lastNow.total}`;
        if (eventKey === lastUsageEventKey) continue;
        lastUsageEventKey = eventKey;

        let deltaInput = 0;
        let deltaOutput = 0;
        let deltaCached = 0;
        let deltaReasoning = 0;

        if (totalUsage) {
          if (prevTotal) {
            deltaInput = Math.max(0, totalNow.input - prevTotal.input);
            deltaOutput = Math.max(0, totalNow.output - prevTotal.output);
            deltaCached = Math.max(0, totalNow.cached - prevTotal.cached);
            deltaReasoning = Math.max(0, totalNow.reasoning - prevTotal.reasoning);
          } else {
            deltaInput = totalNow.input;
            deltaOutput = totalNow.output;
            deltaCached = totalNow.cached;
            deltaReasoning = totalNow.reasoning;
          }
          prevTotal = totalNow;
        } else {
          deltaInput = lastNow.input;
          deltaOutput = lastNow.output;
          deltaCached = lastNow.cached;
          deltaReasoning = lastNow.reasoning;
        }

        if (deltaInput + deltaOutput + deltaCached + deltaReasoning <= 0) continue;
        if (timestampMs < args.fromMs || timestampMs > args.toMs) continue;

        if (projectRoot) {
          const cwd = sessionCwd.trim();
          if (!cwd.length || !isPathWithin(cwd, projectRoot)) continue;
        }

        const model = currentModel.length ? currentModel : "openai/gpt-5.4-mini";
        const normalizedModel = parseModelString(model).normalized;
        const safeInput = Math.max(0, Math.floor(deltaInput));
        const safeOutput = Math.max(0, Math.floor(deltaOutput));
        const safeCached = Math.max(0, Math.floor(deltaCached));

        inputTokens += safeInput;
        outputTokens += safeOutput;
        cacheReadTokens += safeCached;
        const entryCost = estimateTokenCost(normalizedModel, safeInput, safeOutput);
        costUsd += entryCost;
        samples += 1;

        if (oldestEntryMs === null || timestampMs < oldestEntryMs) {
          oldestEntryMs = timestampMs;
        }
        const provider = inferProviderFromModel(normalizedModel);
        if (!(provider in oldestByProvider) || timestampMs < oldestByProvider[provider]) {
          oldestByProvider[provider] = timestampMs;
        }

        const bucket = byProvider[provider] ?? (byProvider[provider] = emptyProviderUsage());
        bucket.inputTokens += safeInput;
        bucket.outputTokens += safeOutput;
        bucket.cacheReadTokens += safeCached;
        bucket.totalTokens += safeInput + safeOutput + safeCached;
        bucket.costUsd += entryCost;
        bucket.samples += 1;
      }
    } catch (error) {
      args.logger.debug("mission_budget.read_codex_jsonl_failed", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
  projectConfigService?: ReturnType<typeof createProjectConfigService> | null;
}) {
  const {
    db,
    logger,
    projectId,
    projectRoot,
    missionService,
    aiIntegrationService,
    projectConfigService,
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

  const resolveTelemetryConfig = (): {
    enabled: boolean;
    claudeProjectsRoot: string | null;
    codexSessionsRoot: string | null;
  } => {
    const telemetry = projectConfigService?.get().effective.cto?.budgetTelemetry;
    const claudeProjectsRoot =
      typeof telemetry?.claudeProjectsRoot === "string" && telemetry.claudeProjectsRoot.trim().length > 0
        ? telemetry.claudeProjectsRoot.trim()
        : null;
    const codexSessionsRoot =
      typeof telemetry?.codexSessionsRoot === "string" && telemetry.codexSessionsRoot.trim().length > 0
        ? telemetry.codexSessionsRoot.trim()
        : null;
    return {
      enabled: telemetry?.enabled !== false,
      claudeProjectsRoot,
      codexSessionsRoot,
    };
  };

  const readClaudeUsageWindow = (windowArgs: {
    fromMs: number;
    toMs: number;
    projectRoot: string | null;
  }): ClaudWindowUsage => {
    const telemetry = resolveTelemetryConfig();
    if (!telemetry.enabled) return mergeWindowUsage([]);
    return readClaudeJsonlWindow({
      ...windowArgs,
      claudeProjectsRoot: telemetry.claudeProjectsRoot,
      logger,
    });
  };

  const readCodexUsageWindow = (windowArgs: {
    fromMs: number;
    toMs: number;
    projectRoot: string | null;
  }): ClaudWindowUsage => {
    const telemetry = resolveTelemetryConfig();
    if (!telemetry.enabled) return mergeWindowUsage([]);
    return readCodexJsonlWindow({
      ...windowArgs,
      codexSessionsRoot: telemetry.codexSessionsRoot,
      logger,
    });
  };

  const collectProviderWindowUsage = (args: {
    nowMs: number;
  }): {
    fiveHourUsage: ClaudWindowUsage;
    weeklyUsage: ClaudWindowUsage;
    dataSources: string[];
  } => {
    const fiveHourClaudeUsage = readClaudeUsageWindow({
      fromMs: args.nowMs - FIVE_HOUR_MS,
      toMs: args.nowMs,
      projectRoot: null,
    });
    const fiveHourCodexUsage = readCodexUsageWindow({
      fromMs: args.nowMs - FIVE_HOUR_MS,
      toMs: args.nowMs,
      projectRoot: null,
    });
    const fiveHourUsage = mergeWindowUsage([fiveHourClaudeUsage, fiveHourCodexUsage]);

    const weeklyClaudeUsage = readClaudeUsageWindow({
      fromMs: args.nowMs - WEEKLY_MS,
      toMs: args.nowMs,
      projectRoot: null,
    });
    const weeklyCodexUsage = readCodexUsageWindow({
      fromMs: args.nowMs - WEEKLY_MS,
      toMs: args.nowMs,
      projectRoot: null,
    });
    const weeklyUsage = mergeWindowUsage([weeklyClaudeUsage, weeklyCodexUsage]);

    const dataSources: string[] = [];
    if (fiveHourClaudeUsage.samples > 0 || weeklyClaudeUsage.samples > 0) {
      dataSources.push("~/.claude/projects/*.jsonl");
    }
    if (fiveHourCodexUsage.samples > 0 || weeklyCodexUsage.samples > 0) {
      dataSources.push("~/.codex/sessions/*.jsonl");
    }
    return {
      fiveHourUsage,
      weeklyUsage,
      dataSources,
    };
  };

  const readExternalMcpCosts = (args: {
    missionId: string;
    runId?: string | null;
  }): {
    byStepId: Map<string, number>;
    unscopedCostUsd: number;
    totalCostUsd: number;
  } => {
    const runId = typeof args.runId === "string" && args.runId.trim().length > 0 ? args.runId.trim() : null;
    const rows = db.all<ExternalMcpCostRow>(
      `
        select
          step_id,
          coalesce(sum(cost_cents), 0) as total_cost_cents
        from external_mcp_usage_events
        where project_id = ?
          and mission_id = ?
          and (? is null or run_id = ?)
        group by step_id
      `,
      [projectId, args.missionId, runId, runId],
    );
    const byStepId = new Map<string, number>();
    let unscopedCostUsd = 0;
    let totalCostUsd = 0;
    for (const row of rows) {
      const costUsd = Math.max(0, Number((Number(row.total_cost_cents ?? 0) / 100).toFixed(6)));
      if (costUsd <= 0) continue;
      const stepId = typeof row.step_id === "string" ? row.step_id.trim() : "";
      totalCostUsd += costUsd;
      if (stepId.length > 0) {
        byStepId.set(stepId, costUsd);
      } else {
        unscopedCostUsd += costUsd;
      }
    }
    return {
      byStepId,
      unscopedCostUsd: Number(unscopedCostUsd.toFixed(6)),
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
    };
  };

  const estimateLaunchBudget = async (args: {
    launch: CreateMissionArgs;
    selectedPhases: PhaseCard[];
  }): Promise<LaunchBudgetEstimate> => {
    const mode = await resolveBudgetMode();
    const orchestratorModelId = String(args.launch.modelConfig?.orchestratorModel?.modelId ?? "").trim() || null;
    const selectedModelPaths = collectModelBudgetPaths({
      selectedPhases: args.selectedPhases,
      orchestratorModelId,
    });
    const includesApiModels = selectedModelPaths.hasApiModels || mode === "api-key";
    const perPhase: MissionPreflightPhaseEstimate[] = [];

    let totalTokens = 0;
    let totalTimeMs = 0;
    let totalCostUsd = 0;
    let hasTokenEstimate = false;
    let hasTimeEstimate = false;
    let hasCostEstimate = false;

    for (const phase of args.selectedPhases) {
      const defaults = resolvePhaseBudgetDefaults(phase.phaseKey);
      const configuredTokens = toNonNegativeInt(phase.budget.maxTokens);
      const configuredTimeMs = toNonNegativeInt(phase.budget.maxTimeMs);
      const estimatedTokens = configuredTokens ?? defaults.tokens;
      const estimatedTimeMs = configuredTimeMs ?? defaults.timeMs;
      const model = parseModelString(phase.model.modelId).normalized;
      const modelBudgetPath = resolveModelBudgetPath(model);
      const estimatedCostUsd = includesApiModels && (mode === "api-key" || modelBudgetPath.apiMetered)
        ? estimateTokenCost(model, Math.floor(estimatedTokens * 0.6), Math.floor(estimatedTokens * 0.4))
        : null;

      totalTokens += estimatedTokens;
      totalTimeMs += estimatedTimeMs;
      if (estimatedCostUsd != null) {
        totalCostUsd += estimatedCostUsd;
        hasCostEstimate = true;
      }
      hasTokenEstimate = true;
      hasTimeEstimate = true;

      perPhase.push({
        phaseKey: phase.phaseKey,
        phaseName: phase.name,
        estimatedTokens,
        estimatedCostUsd: estimatedCostUsd != null ? Number(estimatedCostUsd.toFixed(6)) : null,
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
    if (mode === "subscription" || budgetLimitCostUsd != null) {
      const nowMs = Date.now();
      const fiveHoursAgo = nowMs - FIVE_HOUR_MS;
      const usage = mergeWindowUsage([
        readClaudeUsageWindow({
          fromMs: fiveHoursAgo,
          toMs: nowMs,
          projectRoot: null,
        }),
        readCodexUsageWindow({
          fromMs: fiveHoursAgo,
          toMs: nowMs,
          projectRoot: null,
        }),
      ]);
      if (mode === "subscription") {
        windowUsageCostUsd = usage.costUsd;
      }
      if (windowUsageCostUsd == null) {
        windowUsageCostUsd = usage.costUsd;
      }
      if (budgetLimitCostUsd != null) {
        remainingWindowCostUsd = Math.max(0, budgetLimitCostUsd - usage.costUsd);
      }
    }
    const actualSpendUsd = roundCost(windowUsageCostUsd ?? null);
    const burnRateUsdPerHour = mode === "api-key" && includesApiModels && actualSpendUsd != null
      ? roundCost(actualSpendUsd / 5)
      : null;
    const forecast = includesApiModels && hasCostEstimate
      ? buildForecastFromEstimate({
          estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
          estimatedTimeMs: hasTimeEstimate ? totalTimeMs : null,
          sampleSize: Math.max(1, perPhase.length),
          basis: "phase budget heuristics + selected model pricing",
        })
      : null;

    const hardLimitExceeded = includesApiModels
      && remainingWindowCostUsd != null
      && totalCostUsd > remainingWindowCostUsd;

    const estimate: MissionPreflightBudgetEstimate = {
      mode,
      estimatedTokens: hasTokenEstimate ? totalTokens : null,
      estimatedCostUsd: hasCostEstimate ? Number(totalCostUsd.toFixed(6)) : null,
      estimatedTimeMs: hasTimeEstimate ? totalTimeMs : null,
      actualSpendUsd,
      burnRateUsdPerHour,
      ...(forecast ? { forecast } : {}),
      perPhase,
      ...(remainingWindowCostUsd != null
        ? {
            note: `Estimated remaining 5-hour capacity: ~$${remainingWindowCostUsd.toFixed(2)} (based on local CLI session usage).`,
          }
        : mode === "subscription"
          ? {
              note: "Subscription mode uses observed local CLI telemetry; predictive cost forecasts are intentionally disabled.",
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
    const externalMcpCosts = readExternalMcpCosts({
      missionId,
      runId: runRow?.id ?? runIdFilter,
    });
    const unmatchedExternalMcpCostByStep = new Map(externalMcpCosts.byStepId);

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
    const smartBudgetEnabled = smartBudget?.enabled === true;
    const orchestratorModelId = modelConfig && isRecord(modelConfig.orchestratorModel) && typeof (modelConfig.orchestratorModel as Record<string, unknown>).modelId === "string"
      ? (modelConfig.orchestratorModel as Record<string, unknown>).modelId as string
      : "anthropic/claude-sonnet-4-6";
    const selectedModelPaths = collectModelBudgetPaths({
      selectedPhases,
      orchestratorModelId,
    });
    const selectedSubscriptionProviders = selectedModelPaths.subscriptionProviders;
    const hasSelectedApiModels = selectedModelPaths.hasApiModels || mode === "api-key";
    const configuredMaxCostUsd = smartBudgetEnabled
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
      const modelBudgetPath = resolveModelBudgetPath(model);
      const meteredCostUsd = mode === "api-key" || modelBudgetPath.apiMetered
        ? estimateTokenCost(model, inputTokens, outputTokens)
        : 0;
      const externalStepCostUsd = unmatchedExternalMcpCostByStep.get(row.step_id) ?? 0;
      unmatchedExternalMcpCostByStep.delete(row.step_id);
      const usedCostUsd = Number((meteredCostUsd + externalStepCostUsd).toFixed(6));

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
    if (externalMcpCosts.totalCostUsd > 0) {
      missionUsedCostUsd = Number((
        missionUsedCostUsd
        + externalMcpCosts.unscopedCostUsd
        + [...unmatchedExternalMcpCostByStep.values()].reduce((sum, value) => sum + value, 0)
      ).toFixed(6));
    }

    const dataSources = ["ai_usage_log", "orchestrator_attempts"];
    if (externalMcpCosts.totalCostUsd > 0) {
      dataSources.push("external_mcp_usage_events");
    }

    const runStart = Date.parse(runRow?.started_at ?? missionRow.started_at ?? missionRow.completed_at ?? nowIso());
    const runEnd = Date.parse(runRow?.completed_at ?? missionRow.completed_at ?? nowIso());
    const scopedCliUsage = mode === "subscription" && Number.isFinite(runStart) && Number.isFinite(runEnd)
      ? mergeWindowUsage([
          readClaudeUsageWindow({
            fromMs: runStart,
            toMs: runEnd,
            projectRoot,
          }),
          readCodexUsageWindow({
            fromMs: runStart,
            toMs: runEnd,
            projectRoot,
          }),
        ])
      : null;

    if (scopedCliUsage && scopedCliUsage.samples > 0) {
      if (missionUsedTokens === 0) {
        missionUsedTokens = scopedCliUsage.totalTokens;
      }
      if (missionUsedCostUsd === 0 && !hasSelectedApiModels) {
        missionUsedCostUsd = scopedCliUsage.costUsd;
      }
      if (!dataSources.includes("~/.claude/projects/*.jsonl") && Object.keys(scopedCliUsage.byProvider).includes("claude")) {
        dataSources.push("~/.claude/projects/*.jsonl");
      }
      if (!dataSources.includes("~/.codex/sessions/*.jsonl") && Object.keys(scopedCliUsage.byProvider).includes("codex")) {
        dataSources.push("~/.codex/sessions/*.jsonl");
      }
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
    const providerWindowUsage = collectProviderWindowUsage({ nowMs });
    const fiveHourUsage = providerWindowUsage.fiveHourUsage;
    const weeklyUsage = providerWindowUsage.weeklyUsage;
    for (const source of providerWindowUsage.dataSources) {
      if (!dataSources.includes(source)) dataSources.push(source);
    }

    const providerLimits = smartBudget && isRecord(smartBudget.providerLimits)
      ? smartBudget.providerLimits as Record<string, unknown>
      : null;

    // Collect providers used in this mission (from step rows + JSONL windows).
    // Hard-cap enforcement is scoped to selected providers only.
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
    for (const provider of selectedSubscriptionProviders) missionProviders.add(provider);
    // Ensure at least the orchestrator model's provider is present for visibility
    missionProviders.add(inferProviderFromModel(orchestratorModelId));

    const fiveHourHardStopPercent = smartBudgetEnabled && typeof smartBudget?.fiveHourHardStopPercent === "number"
      ? smartBudget.fiveHourHardStopPercent
      : null;
    const weeklyHardStopPercent = smartBudgetEnabled && typeof smartBudget?.weeklyHardStopPercent === "number"
      ? smartBudget.weeklyHardStopPercent
      : null;
    const apiKeyMaxSpendUsd = smartBudgetEnabled && typeof smartBudget?.apiKeyMaxSpendUsd === "number"
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

      const shouldEnforceSubscriptionHardStops = selectedSubscriptionProviders.has(provider as "claude" | "codex");
      if (shouldEnforceSubscriptionHardStops && fiveHourHardStopPercent != null && fiveHrPct != null && fiveHrPct >= fiveHourHardStopPercent) {
        fiveHourTriggered = true;
      }
      if (shouldEnforceSubscriptionHardStops && weeklyHardStopPercent != null && weeklyPct != null && weeklyPct >= weeklyHardStopPercent) {
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
    if (apiKeyMaxSpendUsd != null && hasSelectedApiModels && missionUsedCostUsd >= apiKeyMaxSpendUsd) {
      apiKeyTriggered = true;
    }

    const hardCaps: MissionBudgetHardCapStatus = {
      fiveHourHardStopPercent: typeof fiveHourHardStopPercent === "number" ? fiveHourHardStopPercent : null,
      weeklyHardStopPercent: typeof weeklyHardStopPercent === "number" ? weeklyHardStopPercent : null,
      apiKeyMaxSpendUsd: typeof apiKeyMaxSpendUsd === "number" ? apiKeyMaxSpendUsd : null,
      apiKeySpentUsd: hasSelectedApiModels ? missionUsedCostUsd : 0,
      fiveHourTriggered,
      weeklyTriggered,
      apiKeyTriggered,
    };

    const pressure = computePressure(missionScope);
    const terminalStatuses = new Set(["succeeded", "failed", "blocked", "canceled", "skipped", "superseded"]);
    const completedWorkers = stepRows.filter((row) => terminalStatuses.has(row.status)).length;
    const remainingStepCount = Math.max(0, stepRows.length - completedWorkers);
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
    const elapsedForBurnMs = (() => {
      if (missionScope.usedTimeMs > 0) return missionScope.usedTimeMs;
      if (!runRow?.started_at) return 0;
      const startMs = Date.parse(runRow.started_at);
      const endMs = runRow.completed_at ? Date.parse(runRow.completed_at) : Date.now();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
      return Math.max(0, endMs - startMs);
    })();
    const burnRateUsdPerHour = hasSelectedApiModels && elapsedForBurnMs > 0 && missionScope.usedCostUsd > 0
      ? roundCost(missionScope.usedCostUsd / (elapsedForBurnMs / 3_600_000))
      : null;

    let forecast: MissionBudgetForecast | null = null;
    if (hasSelectedApiModels) {
      if (stepRows.length > 0 && completedWorkers > 0) {
        const avgCostPerStep = missionScope.usedCostUsd / completedWorkers;
        const avgDurationPerStep = missionScope.usedTimeMs > 0 ? missionScope.usedTimeMs / completedWorkers : null;
        const projectedCost = missionScope.usedCostUsd + (avgCostPerStep * remainingStepCount);
        const projectedDuration = avgDurationPerStep != null
          ? missionScope.usedTimeMs + (avgDurationPerStep * remainingStepCount)
          : null;
        forecast = {
          lowCostUsd: roundCost(missionScope.usedCostUsd + (avgCostPerStep * remainingStepCount * 0.75)),
          medianCostUsd: roundCost(projectedCost),
          highCostUsd: roundCost(missionScope.usedCostUsd + (avgCostPerStep * remainingStepCount * 1.35)),
          lowDurationMs: projectedDuration != null ? roundDuration(missionScope.usedTimeMs + (avgDurationPerStep! * remainingStepCount * 0.75)) : null,
          medianDurationMs: projectedDuration != null ? roundDuration(projectedDuration) : null,
          highDurationMs: projectedDuration != null ? roundDuration(missionScope.usedTimeMs + (avgDurationPerStep! * remainingStepCount * 1.35)) : null,
          confidence: clampConfidence(0.35 + Math.min(0.55, completedWorkers / 10)),
          sampleSize: completedWorkers,
          basis: "completed step usage in this run",
        };
      } else {
        forecast = buildForecastFromEstimate({
          estimatedCostUsd: missionScope.maxCostUsd ?? null,
          estimatedTimeMs: missionScope.maxTimeMs ?? null,
          sampleSize: 0,
          basis: "configured mission budget caps",
        });
      }
    }

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
      burnRateUsdPerHour,
      forecast,
      estimatedRemainingCapacity: {
        steps: remainingStepsEstimate,
        durationMs: remainingDurationEstimate,
      },
      rateLimits: [],
      dataSources,
    };
  };

  const getMissionBudgetTelemetry = (
    telemetryArgs: GetMissionBudgetTelemetryArgs = {},
  ): MissionBudgetTelemetrySnapshot => {
    const nowMs = Date.now();
    const providerWindowUsage = collectProviderWindowUsage({ nowMs });
    const requestedProviders = new Set(
      (telemetryArgs.providers ?? ["claude", "codex"])
        .map((entry) => String(entry ?? "").trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    );
    if (requestedProviders.size === 0) {
      requestedProviders.add("claude");
      requestedProviders.add("codex");
    }
    const providerLimits = telemetryArgs.providerLimits
      ? telemetryArgs.providerLimits as Record<string, unknown>
      : null;
    const perProvider: MissionBudgetProviderSnapshot[] = [...requestedProviders]
      .sort((a, b) => a.localeCompare(b))
      .map((provider) => {
        const fiveHrBucket = providerWindowUsage.fiveHourUsage.byProvider[provider] ?? emptyProviderUsage();
        const weeklyBucket = providerWindowUsage.weeklyUsage.byProvider[provider] ?? emptyProviderUsage();
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
        const fiveHrOldest = providerWindowUsage.fiveHourUsage.oldestByProvider[provider] ?? null;
        const weeklyOldest = providerWindowUsage.weeklyUsage.oldestByProvider[provider] ?? null;
        return {
          provider,
          fiveHour: {
            usedTokens: fiveHrBucket.totalTokens,
            limitTokens: fiveHourTokenLimit,
            usedPct: fiveHrPct,
            usedCostUsd: fiveHrBucket.costUsd,
            timeUntilResetMs: fiveHrBucket.samples > 0 && fiveHrOldest != null
              ? Math.max(0, (fiveHrOldest + FIVE_HOUR_MS) - nowMs)
              : null,
          },
          weekly: {
            usedTokens: weeklyBucket.totalTokens,
            limitTokens: weeklyTokenLimit,
            usedPct: weeklyPct,
            usedCostUsd: weeklyBucket.costUsd,
            timeUntilResetMs: weeklyBucket.samples > 0 && weeklyOldest != null
              ? Math.max(0, (weeklyOldest + WEEKLY_MS) - nowMs)
              : null,
          },
        };
      });
    return {
      computedAt: nowIso(),
      perProvider,
      dataSources: providerWindowUsage.dataSources,
    };
  };

  return {
    estimateLaunchBudget,
    getMissionBudgetStatus,
    getMissionBudgetTelemetry,
  };
}

export type MissionBudgetService = ReturnType<typeof createMissionBudgetService>;
