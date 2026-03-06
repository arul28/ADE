import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "../lanes/laneService";
import type { Logger } from "../logging/logger";
import {
  type ProjectPackBuilderDeps,
  readContextDocMeta as readContextDocMetaImpl,
  readContextStatus as readContextStatusImpl,
  resolveContextDocPath as resolveContextDocPathImpl,
  runContextDocGeneration as runContextDocGenerationImpl,
} from "../packs/projectPackBuilder";
import { getErrorMessage, toOptionalString } from "../shared/utils";
import type { AdeDb } from "../state/kvDb";
import type {
  ContextDocStatus,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextRefreshTrigger,
  ContextStatus,
} from "../../../shared/types";

type ContextDocRefreshPrefs = {
  cadence: ContextRefreshTrigger;
  provider: "codex" | "claude" | "unified";
  modelId: string | null;
  reasoningEffort: string | null;
  updatedAt: string;
};

const CONTEXT_DOC_PREFS_KEY = "context:docs:preferences.v1";
const CONTEXT_DOC_LAST_RUN_KEY = "context:docs:lastRun.v1";
const AUTO_REFRESH_MIN_INTERVAL_MS: Record<Exclude<ContextRefreshTrigger, "manual">, number> = {
  per_mission: 15 * 60_000,
  per_pr: 15 * 60_000,
  per_lane_refresh: 45 * 60_000,
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRefreshTrigger(value: unknown): ContextRefreshTrigger {
  const normalized = String(value ?? "").trim();
  if (normalized === "per_mission" || normalized === "per_pr" || normalized === "per_lane_refresh") return normalized;
  return "manual";
}

function normalizeContextProvider(value: unknown): "codex" | "claude" | "unified" {
  const normalized = String(value ?? "").trim();
  if (normalized === "codex" || normalized === "claude") return normalized;
  return "unified";
}

export function createContextDocService(args: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  projectId: string;
  packsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  aiIntegrationService?: ReturnType<typeof createAiIntegrationService>;
}) {
  const {
    db,
    logger,
    projectRoot,
    projectId,
    packsDir,
    laneService,
    projectConfigService,
    aiIntegrationService,
  } = args;

  const projectPackBuilderDeps: ProjectPackBuilderDeps = {
    db,
    logger,
    projectRoot,
    projectId,
    packsDir,
    laneService,
    projectConfigService,
    aiIntegrationService,
  };

  const readContextDocRefreshPrefs = (): ContextDocRefreshPrefs | null => {
    const raw = db.getJson<Record<string, unknown>>(CONTEXT_DOC_PREFS_KEY);
    if (!raw) return null;
    return {
      cadence: normalizeRefreshTrigger(raw.cadence),
      provider: normalizeContextProvider(raw.provider),
      modelId: toOptionalString(raw.modelId),
      reasoningEffort: toOptionalString(raw.reasoningEffort),
      updatedAt: toOptionalString(raw.updatedAt) ?? nowIso(),
    };
  };

  const persistContextDocRefreshPrefs = (docArgs: ContextGenerateDocsArgs): ContextDocRefreshPrefs => {
    const prefs: ContextDocRefreshPrefs = {
      cadence: normalizeRefreshTrigger(docArgs.trigger),
      provider: normalizeContextProvider(docArgs.provider),
      modelId: toOptionalString(docArgs.modelId),
      reasoningEffort: toOptionalString(docArgs.reasoningEffort),
      updatedAt: nowIso(),
    };
    db.setJson(CONTEXT_DOC_PREFS_KEY, prefs);
    return prefs;
  };

  const readLastContextDocRunAt = (): number | null => {
    const raw = db.getJson<Record<string, unknown>>(CONTEXT_DOC_LAST_RUN_KEY);
    const generatedAt = toOptionalString(raw?.generatedAt);
    if (!generatedAt) return null;
    const ts = Date.parse(generatedAt);
    return Number.isFinite(ts) ? ts : null;
  };

  const generateDocs = async (docArgs: ContextGenerateDocsArgs): Promise<ContextGenerateDocsResult> => {
    persistContextDocRefreshPrefs(docArgs);
    return await runContextDocGenerationImpl(projectPackBuilderDeps, docArgs);
  };

  const maybeAutoRefreshDocs = async (docArgs: {
    trigger: Exclude<ContextRefreshTrigger, "manual">;
    reason?: string;
    force?: boolean;
  }): Promise<ContextGenerateDocsResult | null> => {
    const trigger = normalizeRefreshTrigger(docArgs.trigger);
    if (trigger === "manual") return null;
    const prefs = readContextDocRefreshPrefs();
    if (!prefs || prefs.cadence !== trigger) return null;
    const minIntervalMs = AUTO_REFRESH_MIN_INTERVAL_MS[trigger];
    if (!docArgs.force) {
      const lastRunAt = readLastContextDocRunAt();
      if (lastRunAt != null && Date.now() - lastRunAt < minIntervalMs) {
        logger.debug("context_docs.auto_refresh_skipped_recent", {
          trigger,
          reason: docArgs.reason ?? null,
          minIntervalMs,
        });
        return null;
      }
    }

    try {
      logger.info("context_docs.auto_refresh_start", {
        trigger,
        reason: docArgs.reason ?? null,
        provider: prefs.provider,
        modelId: prefs.modelId,
      });
      return await generateDocs({
        provider: prefs.provider,
        ...(prefs.modelId ? { modelId: prefs.modelId } : {}),
        ...(prefs.reasoningEffort ? { reasoningEffort: prefs.reasoningEffort } : {}),
        trigger,
      });
    } catch (error) {
      logger.warn("context_docs.auto_refresh_failed", {
        trigger,
        reason: docArgs.reason ?? null,
        error: getErrorMessage(error),
      });
      return null;
    }
  };

  return {
    getDocMeta() {
      return readContextDocMetaImpl(projectRoot);
    },
    getStatus(): ContextStatus {
      return readContextStatusImpl({ db, projectId, projectRoot, packsDir });
    },
    generateDocs,
    maybeAutoRefreshDocs,
    getDocPath(docId: ContextDocStatus["id"]): string {
      return resolveContextDocPathImpl(projectRoot, docId);
    },
  };
}

export type ContextDocService = ReturnType<typeof createContextDocService>;
