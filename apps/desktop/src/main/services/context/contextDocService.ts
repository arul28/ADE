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
} from "./contextDocBuilder";
import { getErrorMessage, nowIso, toOptionalString } from "../shared/utils";
import type { AdeDb } from "../state/kvDb";
import type {
  ContextDocGenerationEvent,
  ContextDocGenerationSource,
  ContextDocGenerationStatus,
  ContextDocPrefs,
  ContextDocStatus,
  ContextGenerateDocsArgs,
  ContextGenerateDocsResult,
  ContextRefreshEvents,
  ContextRefreshTrigger,
  ContextStatus,
} from "../../../shared/types";

/** Event names that can trigger auto-refresh of context docs. */
export type ContextRefreshEventName = ContextDocGenerationEvent;

type ContextDocRefreshPrefs = {
  cadence: ContextRefreshTrigger;
  events: ContextRefreshEvents;
  provider: "codex" | "claude" | "opencode";
  modelId: string | null;
  reasoningEffort: string | null;
  updatedAt: string;
};

type GenerationRunMeta = {
  source: ContextDocGenerationStatus["source"];
  event?: ContextDocGenerationStatus["event"];
  reason?: string | null;
  requestedAt?: string | null;
  provider?: ContextDocGenerationStatus["provider"];
  modelId?: string | null;
  reasoningEffort?: string | null;
};

const CONTEXT_DOC_LOG_MESSAGE_MAX = 2_000;

function logMetaForContextGenerateResult(
  result: ContextGenerateDocsResult,
  meta: GenerationRunMeta,
): Record<string, unknown> {
  const clip = (msg: string) =>
    msg.length > CONTEXT_DOC_LOG_MESSAGE_MAX ? `${msg.slice(0, CONTEXT_DOC_LOG_MESSAGE_MAX)}…` : msg;
  return {
    source: meta.source ?? null,
    event: meta.event ?? null,
    reason: meta.reason ?? null,
    provider: meta.provider ?? null,
    modelId: meta.modelId ?? null,
    reasoningEffort: meta.reasoningEffort ?? null,
    degraded: result.degraded,
    usedFallbackPath: result.usedFallbackPath,
    generatedAt: result.generatedAt,
    warningCount: result.warnings.length,
    warnings: result.warnings.map((w) => ({
      code: w.code,
      message: clip(String(w.message ?? "")),
      ...(w.actionLabel ? { actionLabel: w.actionLabel } : {}),
      ...(w.actionPath ? { actionPath: w.actionPath } : {}),
    })),
    docResults: result.docResults.map((d) => ({
      id: d.id,
      health: d.health,
      source: d.source,
      sizeBytes: d.sizeBytes,
    })),
  };
}

const CONTEXT_DOC_PREFS_KEY = "context:docs:preferences.v1";
const CONTEXT_DOC_LAST_RUN_KEY = "context:docs:lastRun.v1";
const CONTEXT_DOC_GENERATION_STATUS_KEY = "context:docs:generationStatus.v1";
const STALE_GENERATION_TIMEOUT_MS = 5 * 60_000;

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

function normalizeContextProvider(value: unknown): "codex" | "claude" | "opencode" {
  const normalized = String(value ?? "").trim();
  if (normalized === "codex" || normalized === "claude") return normalized;
  return "opencode";
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

function normalizeGenerationEvent(value: unknown): ContextDocGenerationEvent | null {
  const normalized = String(value ?? "").trim();
  return normalized in EVENT_NAME_TO_KEY ? normalized as ContextDocGenerationEvent : null;
}

function normalizeGenerationSource(value: unknown): ContextDocGenerationSource | null {
  const normalized = String(value ?? "").trim();
  if (normalized === "manual" || normalized === "auto") return normalized;
  return null;
}

function pickDefined<T>(value: T | undefined, fallback: T): T {
  return value !== undefined ? value : fallback;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
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
  onStatusChanged?: (status: ContextStatus) => void;
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
    onStatusChanged,
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

  let activeGeneration: Promise<ContextGenerateDocsResult> | null = null;

  const buildStatusSnapshot = (): ContextStatus => ({
    ...readContextStatusImpl({ db, projectId, projectRoot, packsDir }),
    generation: reconcileGenerationStatus(),
  });

  const emitStatusChanged = (): void => {
    if (!onStatusChanged) return;
    try {
      onStatusChanged(buildStatusSnapshot());
    } catch (error) {
      logger.debug("context_docs.status_emit_failed", {
        error: getErrorMessage(error),
      });
    }
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

  const readGenerationStatus = (): ContextStatus["generation"] => {
    const raw = db.getJson<Record<string, unknown>>(CONTEXT_DOC_GENERATION_STATUS_KEY);
    const finishedAt = toOptionalString(raw?.finishedAt) ?? null;
    const error = toOptionalString(raw?.error) ?? null;
    const rawState = toOptionalString(raw?.state);
    const state: ContextDocGenerationStatus["state"] = (() => {
      if (
        rawState === "pending"
        || rawState === "running"
        || rawState === "succeeded"
        || rawState === "failed"
      ) {
        return rawState;
      }
      if (rawState === "idle" && finishedAt && !error) return "succeeded";
      return "idle";
    })();
    const sourceValue = normalizeGenerationSource(raw?.source);
    const eventValue = normalizeGenerationEvent(raw?.event);
    const providerValue = toOptionalString(raw?.provider);
    return {
      state,
      requestedAt: toOptionalString(raw?.requestedAt) ?? null,
      startedAt: toOptionalString(raw?.startedAt) ?? null,
      finishedAt,
      error,
      source: sourceValue,
      event: eventValue,
      reason: toOptionalString(raw?.reason) ?? null,
      provider: providerValue === "codex" || providerValue === "claude" || providerValue === "opencode" ? providerValue : null,
      modelId: toOptionalString(raw?.modelId) ?? null,
      reasoningEffort: toOptionalString(raw?.reasoningEffort) ?? null,
    };
  };

  const normalizeStaleGenerationStatus = (
    status: ContextDocGenerationStatus,
  ): { status: ContextDocGenerationStatus; changed: boolean } => {
    if (status.state !== "pending" && status.state !== "running") {
      return { status, changed: false };
    }

    const startedAtMs = parseIsoMs(status.startedAt);
    const requestedAtMs = parseIsoMs(status.requestedAt);
    const baselineMs = startedAtMs ?? requestedAtMs;
    if (baselineMs == null) {
      return {
        status: {
          ...status,
          state: "failed",
          finishedAt: nowIso(),
          error: "Context doc generation state was left in progress without timestamps. ADE reset it.",
        },
        changed: true,
      };
    }

    if (Date.now() - baselineMs <= STALE_GENERATION_TIMEOUT_MS) {
      return { status, changed: false };
    }

    return {
      status: {
        ...status,
        state: "failed",
        finishedAt: nowIso(),
        error: "Previous context doc generation did not finish. ADE reset the stale in-progress state.",
      },
      changed: true,
    };
  };

  const reconcileGenerationStatus = (): ContextDocGenerationStatus => {
    const current = readGenerationStatus();
    if (activeGeneration && (current.state === "pending" || current.state === "running")) {
      return current;
    }
    const normalized = normalizeStaleGenerationStatus(current);
    if (normalized.changed) {
      db.setJson(CONTEXT_DOC_GENERATION_STATUS_KEY, normalized.status);
    }
    return normalized.status;
  };

  const writeGenerationStatus = (next: ContextStatus["generation"]): void => {
    db.setJson(CONTEXT_DOC_GENERATION_STATUS_KEY, next);
    emitStatusChanged();
  };

  const buildGenerationStatus = (args: {
    state: ContextDocGenerationStatus["state"];
    requestedAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
    meta?: GenerationRunMeta | null;
    previous?: ContextDocGenerationStatus | null;
  }): ContextDocGenerationStatus => {
    const previous = args.previous ?? readGenerationStatus();
    return {
      state: args.state,
      requestedAt: pickDefined(args.requestedAt, pickDefined(args.meta?.requestedAt, previous.requestedAt ?? null)),
      startedAt: pickDefined(args.startedAt, previous.startedAt ?? null),
      finishedAt: pickDefined(args.finishedAt, previous.finishedAt ?? null),
      error: pickDefined(args.error, null),
      source: pickDefined(args.meta?.source, previous.source ?? null),
      event: pickDefined(args.meta?.event, previous.event ?? null),
      reason: pickDefined(args.meta?.reason, previous.reason ?? null),
      provider: pickDefined(args.meta?.provider, previous.provider ?? null),
      modelId: pickDefined(args.meta?.modelId, previous.modelId ?? null),
      reasoningEffort: pickDefined(args.meta?.reasoningEffort, previous.reasoningEffort ?? null),
    };
  };

  const generateDocsInternal = async (
    docArgs: ContextGenerateDocsArgs,
    meta: GenerationRunMeta,
  ): Promise<ContextGenerateDocsResult> => {
    // If generation is already in-flight, wait for it instead of starting a second one
    if (activeGeneration) {
      logger.info("context_docs.generation_already_running", {
        source: meta.source,
        event: meta.event ?? null,
        reason: meta.reason ?? null,
      });
      return activeGeneration;
    }

    const provider = normalizeContextProvider(docArgs.provider);
    const modelId = toOptionalString(docArgs.modelId);
    const reasoningEffort = toOptionalString(docArgs.reasoningEffort);
    const requestedAt = meta.requestedAt ?? nowIso();
    const startedAt = nowIso();

    persistContextDocRefreshPrefs(docArgs);
    writeGenerationStatus(
      buildGenerationStatus({
        state: "running",
        requestedAt,
        startedAt,
        finishedAt: null,
        error: null,
        meta: {
          ...meta,
          requestedAt,
          provider,
          modelId,
          reasoningEffort,
        },
      })
    );

    const run = async (): Promise<ContextGenerateDocsResult> => {
      try {
        const result = await runContextDocGenerationImpl(projectPackBuilderDeps, docArgs);
        const completeMeta = logMetaForContextGenerateResult(result, meta);
        if (result.warnings.length > 0 || result.degraded) {
          logger.warn("context_docs.generate.complete", completeMeta);
        } else {
          logger.info("context_docs.generate.complete", completeMeta);
        }
        writeGenerationStatus(
          buildGenerationStatus({
            state: "succeeded",
            requestedAt,
            startedAt,
            finishedAt: result.generatedAt,
            error: null,
            meta: {
              ...meta,
              requestedAt,
              provider,
              modelId,
              reasoningEffort,
            },
          })
        );
        return result;
      } catch (error) {
        writeGenerationStatus(
          buildGenerationStatus({
            state: "failed",
            requestedAt,
            startedAt,
            finishedAt: nowIso(),
            error: getErrorMessage(error),
            meta: {
              ...meta,
              requestedAt,
              provider,
              modelId,
              reasoningEffort,
            },
          })
        );
        throw error;
      } finally {
        activeGeneration = null;
      }
    };

    activeGeneration = run();
    return activeGeneration;
  };

  const generateDocs = async (docArgs: ContextGenerateDocsArgs): Promise<ContextGenerateDocsResult> => {
    const modelId = toOptionalString(docArgs.modelId);
    if (!modelId) {
      throw new Error("Select a model before generating context docs.");
    }
    return generateDocsInternal(docArgs, {
      source: "manual",
      reason: "manual_generate",
      provider: normalizeContextProvider(docArgs.provider),
      modelId,
      reasoningEffort: toOptionalString(docArgs.reasoningEffort),
    });
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

    const generationBeforeAttempt = readGenerationStatus();
    const requestedAt = nowIso();
    const pendingMeta = (prefs: ContextDocRefreshPrefs | null): GenerationRunMeta => ({
      source: "auto",
      event,
      reason: docArgs.reason ?? null,
      requestedAt,
      provider: prefs?.provider ?? null,
      modelId: prefs?.modelId ?? null,
      reasoningEffort: prefs?.reasoningEffort ?? null,
    });
    const settlePendingWithoutRun = (): void => {
      if (activeGeneration) return;
      const restored =
        generationBeforeAttempt.state === "running" || generationBeforeAttempt.state === "pending"
          ? { ...generationBeforeAttempt, state: "idle" as const, error: null }
          : generationBeforeAttempt;
      writeGenerationStatus(restored);
    };

    // Check if this event is enabled
    const enabledEvents = resolveEnabledEvents();
    if (!enabledEvents[eventKey]) {
      settlePendingWithoutRun();
      logger.debug("context_docs.auto_refresh_event_disabled", {
        event,
        reason: docArgs.reason ?? null,
      });
      return null;
    }

    // Need stored prefs for provider/model info
    const prefs = readContextDocRefreshPrefs();
    if (!prefs) {
      settlePendingWithoutRun();
      return null;
    }

    if (!prefs.modelId) {
      settlePendingWithoutRun();
      logger.debug("context_docs.auto_refresh_skipped_missing_model", {
        event,
        reason: docArgs.reason ?? null,
      });
      return null;
    }

    if (!activeGeneration) {
      writeGenerationStatus(
        buildGenerationStatus({
          state: "pending",
          requestedAt,
          startedAt: null,
          finishedAt: null,
          error: null,
          meta: pendingMeta(prefs),
        })
      );
    }

    // Throttle: check min interval
    const minIntervalMs = AUTO_REFRESH_MIN_INTERVAL_MS[event];
    if (!docArgs.force) {
      const lastRunAt = readLastContextDocRunAt();
      if (lastRunAt != null && Date.now() - lastRunAt < minIntervalMs) {
        settlePendingWithoutRun();
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
      return await generateDocsInternal({
        provider: prefs.provider,
        ...(prefs.modelId ? { modelId: prefs.modelId } : {}),
        ...(prefs.reasoningEffort ? { reasoningEffort: prefs.reasoningEffort } : {}),
        events: enabledEvents,
      }, {
        source: "auto",
        event,
        reason: docArgs.reason ?? null,
        provider: prefs.provider,
        modelId: prefs.modelId,
        reasoningEffort: prefs.reasoningEffort,
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

  reconcileGenerationStatus();

  return {
    getDocMeta() {
      return readContextDocMetaImpl(projectRoot);
    },
    getStatus(): ContextStatus {
      return buildStatusSnapshot();
    },
    getPrefs(): ContextDocPrefs {
      const stored = readContextDocRefreshPrefs();
      return {
        provider: stored?.provider ?? "opencode",
        modelId: stored?.modelId ?? null,
        reasoningEffort: stored?.reasoningEffort ?? null,
        events: stored?.events ?? DEFAULT_EVENTS,
      };
    },
    savePrefs(prefs: ContextDocPrefs): ContextDocPrefs {
      const args: ContextGenerateDocsArgs = {
        provider: prefs.provider ?? "opencode",
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
