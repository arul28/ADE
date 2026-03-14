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
import { getErrorMessage, nowIso, toOptionalString } from "../shared/utils";
import type { AdeDb } from "../state/kvDb";
import type {
  ContextDocPrefs,
  ContextDocStatus,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextRefreshEvents,
  ContextRefreshTrigger,
  ContextStatus,
} from "../../../shared/types";

/** Event names that can trigger auto-refresh of context docs. */
export type ContextRefreshEventName =
  | "session_end"
  | "commit"
  | "pr_create"
  | "pr_land"
  | "mission_start"
  | "mission_end"
  | "lane_create";

type ContextDocRefreshPrefs = {
  cadence: ContextRefreshTrigger;
  events: ContextRefreshEvents;
  provider: "codex" | "claude" | "unified";
  modelId: string | null;
  reasoningEffort: string | null;
  updatedAt: string;
};

const CONTEXT_DOC_PREFS_KEY = "context:docs:preferences.v1";
const CONTEXT_DOC_LAST_RUN_KEY = "context:docs:lastRun.v1";

/** Minimum interval between auto-refresh runs (per event name). */
const AUTO_REFRESH_MIN_INTERVAL_MS: Record<ContextRefreshEventName, number> = {
  session_end: 45 * 60_000,
  commit: 15 * 60_000,
  pr_create: 15 * 60_000,
  pr_land: 15 * 60_000,
  mission_start: 15 * 60_000,
  mission_end: 15 * 60_000,
  lane_create: 45 * 60_000,
};

/** Default events when none are configured. */
const DEFAULT_EVENTS: ContextRefreshEvents = { onPrCreate: true, onMissionStart: true };

/** Maps an event name to the corresponding key on ContextRefreshEvents. */
const EVENT_NAME_TO_KEY: Record<ContextRefreshEventName, keyof ContextRefreshEvents> = {
  session_end: "onSessionEnd",
  commit: "onCommit",
  pr_create: "onPrCreate",
  pr_land: "onPrLand",
  mission_start: "onMissionStart",
  mission_end: "onMissionEnd",
  lane_create: "onLaneCreate",
};

/** Maps old cadence trigger values to equivalent event flags for backward compat. */
function cadenceToEvents(cadence: ContextRefreshTrigger): ContextRefreshEvents {
  switch (cadence) {
    case "per_mission": return { onMissionStart: true };
    case "per_pr": return { onPrCreate: true };
    case "per_lane_refresh": return { onSessionEnd: true };
    default: return {};
  }
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

function normalizeEvents(value: unknown): ContextRefreshEvents {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const events: ContextRefreshEvents = {};
  for (const key of Object.keys(EVENT_NAME_TO_KEY) as ContextRefreshEventName[]) {
    const fieldKey = EVENT_NAME_TO_KEY[key];
    if (typeof raw[fieldKey] === "boolean") {
      events[fieldKey] = raw[fieldKey] as boolean;
    }
  }
  return events;
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
    const cadence = normalizeRefreshTrigger(raw.cadence);
    const storedEvents = normalizeEvents(raw.events);
    // Backward compat: if no events stored but cadence is set, derive events from cadence
    const hasAnyEvent = Object.values(storedEvents).some(Boolean);
    const events = hasAnyEvent ? storedEvents : cadenceToEvents(cadence);
    return {
      cadence,
      events,
      provider: normalizeContextProvider(raw.provider),
      modelId: toOptionalString(raw.modelId),
      reasoningEffort: toOptionalString(raw.reasoningEffort),
      updatedAt: toOptionalString(raw.updatedAt) ?? nowIso(),
    };
  };

  const persistContextDocRefreshPrefs = (docArgs: ContextGenerateDocsArgs): ContextDocRefreshPrefs => {
    const cadence = normalizeRefreshTrigger(docArgs.trigger);
    const events = docArgs.events ? normalizeEvents(docArgs.events) : cadenceToEvents(cadence);
    const prefs: ContextDocRefreshPrefs = {
      cadence,
      events,
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

  /**
   * Resolves which events are enabled, merging project config with stored prefs.
   * Priority: project config > stored prefs > defaults.
   */
  const resolveEnabledEvents = (): ContextRefreshEvents => {
    // 1. Check project config
    const configSnapshot = projectConfigService.get();
    const configEvents = configSnapshot.shared?.contextRefreshEvents ?? configSnapshot.local?.contextRefreshEvents;
    if (configEvents && Object.values(configEvents).some((v) => typeof v === "boolean")) {
      return configEvents;
    }
    // 2. Check stored prefs
    const prefs = readContextDocRefreshPrefs();
    if (prefs) {
      const hasAnyEvent = Object.values(prefs.events).some(Boolean);
      if (hasAnyEvent) return prefs.events;
    }
    // 3. Defaults
    return DEFAULT_EVENTS;
  };

  const maybeAutoRefreshDocs = async (docArgs: {
    event: ContextRefreshEventName;
    reason?: string;
    force?: boolean;
  }): Promise<ContextGenerateDocsResult | null> => {
    const { event } = docArgs;
    const eventKey = EVENT_NAME_TO_KEY[event];
    if (!eventKey) return null;

    // Check if this event is enabled
    const enabledEvents = resolveEnabledEvents();
    if (!enabledEvents[eventKey]) {
      logger.debug("context_docs.auto_refresh_event_disabled", {
        event,
        reason: docArgs.reason ?? null,
      });
      return null;
    }

    // Need stored prefs for provider/model info
    const prefs = readContextDocRefreshPrefs();
    if (!prefs) return null;

    // Throttle: check min interval
    const minIntervalMs = AUTO_REFRESH_MIN_INTERVAL_MS[event];
    if (!docArgs.force) {
      const lastRunAt = readLastContextDocRunAt();
      if (lastRunAt != null && Date.now() - lastRunAt < minIntervalMs) {
        logger.debug("context_docs.auto_refresh_skipped_recent", {
          event,
          reason: docArgs.reason ?? null,
          minIntervalMs,
        });
        return null;
      }
    }

    try {
      logger.info("context_docs.auto_refresh_start", {
        event,
        reason: docArgs.reason ?? null,
        provider: prefs.provider,
        modelId: prefs.modelId,
      });
      return await generateDocs({
        provider: prefs.provider,
        ...(prefs.modelId ? { modelId: prefs.modelId } : {}),
        ...(prefs.reasoningEffort ? { reasoningEffort: prefs.reasoningEffort } : {}),
        events: enabledEvents,
      });
    } catch (error) {
      logger.warn("context_docs.auto_refresh_failed", {
        event,
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
    getPrefs(): ContextDocPrefs {
      const stored = readContextDocRefreshPrefs();
      return {
        provider: stored?.provider ?? "unified",
        modelId: stored?.modelId ?? null,
        reasoningEffort: stored?.reasoningEffort ?? null,
        events: stored?.events ?? DEFAULT_EVENTS,
      };
    },
    savePrefs(prefs: ContextDocPrefs): ContextDocPrefs {
      const args: ContextGenerateDocsArgs = {
        provider: prefs.provider ?? "unified",
        modelId: prefs.modelId ?? undefined,
        reasoningEffort: prefs.reasoningEffort,
        events: prefs.events,
      };
      const saved = persistContextDocRefreshPrefs(args);
      return {
        provider: saved.provider,
        modelId: saved.modelId,
        reasoningEffort: saved.reasoningEffort,
        events: saved.events,
      };
    },
    generateDocs,
    maybeAutoRefreshDocs,
    getDocPath(docId: ContextDocStatus["id"]): string {
      return resolveContextDocPathImpl(projectRoot, docId);
    },
  };
}

export type ContextDocService = ReturnType<typeof createContextDocService>;
