import type { ProjectConfigFile } from "../../../shared/types";
import { isRecord } from "../shared/utils";

/**
 * The keys a legacy committed `.ade/ade.yaml` may hand to local config.
 *
 * These are display and preference data only. They cannot start a process or
 * an agent session when carried into local config.
 */
export const CARRY_OVER_IMPORTABLE_KEYS = [
  "project",
  "environments",
  "github",
  "ai",
  "linearSync",
  "ui",
  "browser",
] as const satisfies readonly (keyof ProjectConfigFile)[];

/**
 * The keys a legacy committed `.ade/ade.yaml` may NOT hand to local config.
 *
 * Each one reaches an executor: `testSuites` carry a `command`, `laneTemplates`
 * and `laneEnvInit` carry `setupScript` / `dependencies` / `copyPaths`,
 * `laneOverlayPolicies` can override `envInit` per lane, and `automations`
 * launch agent sessions with an attacker-authored prompt. `git` can trigger
 * automatic rebase/push work, while `laneCleanup` can archive lanes. A clone
 * must never be able to smuggle any of them onto your machine, so they are
 * dropped rather than imported. `defaultLaneTemplate` goes with
 * `laneTemplates`: it only names one.
 */
export const CARRY_OVER_EXECUTABLE_KEYS = [
  "testSuites",
  "laneOverlayPolicies",
  "automations",
  "laneEnvInit",
  "laneTemplates",
  "defaultLaneTemplate",
  "git",
  "laneCleanup",
] as const satisfies readonly (keyof ProjectConfigFile)[];

export function hasConfigKeyValue(config: ProjectConfigFile, key: keyof ProjectConfigFile): boolean {
  const value = config[key];
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

type CarryOverAiResult = {
  value: Record<string, unknown> | undefined;
  skipped: string[];
};

export function collectSkippedConfigPaths(value: unknown, prefix: string, skipped: string[]): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    skipped.push(prefix);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPrefix = `${prefix}.${key}`;
    if (isRecord(child) && Object.keys(child).length > 0) {
      collectSkippedConfigPaths(child, childPrefix, skipped);
    } else {
      skipped.push(childPrefix);
    }
  }
}

export function sanitizeCarryOverAiConfig(value: unknown): CarryOverAiResult {
  if (!isRecord(value)) return { value: undefined, skipped: ["ai"] };

  const out: Record<string, unknown> = {};
  const skipped: string[] = [];
  const allowedTopLevel = new Set([
    "features",
    "featureModelOverrides",
    "sessionIntelligence",
    "localProviders",
    "taskRouting",
    "orchestrator",
    "customModelSlugs",
    "modelId",
    "model",
    "defaultModel",
  ]);

  for (const [key, child] of Object.entries(value)) {
    if (!allowedTopLevel.has(key)) {
      collectSkippedConfigPaths(child, `ai.${key}`, skipped);
    }
  }

  const features = value.features;
  if (isRecord(features)) {
    const safe: Record<string, boolean> = {};
    for (const [key, child] of Object.entries(features)) {
      if (typeof child === "boolean") safe[key] = child;
      else collectSkippedConfigPaths(child, `ai.features.${key}`, skipped);
    }
    if (Object.keys(safe).length) out.features = safe;
  } else if (features !== undefined) {
    collectSkippedConfigPaths(features, "ai.features", skipped);
  }

  const featureModels = value.featureModelOverrides;
  if (isRecord(featureModels)) {
    const safe: Record<string, string | null> = {};
    for (const [key, child] of Object.entries(featureModels)) {
      if (child === null) safe[key] = null;
      else if (typeof child === "string" && child.trim()) safe[key] = child.trim();
      else collectSkippedConfigPaths(child, `ai.featureModelOverrides.${key}`, skipped);
    }
    if (Object.keys(safe).length) out.featureModelOverrides = safe;
  } else if (featureModels !== undefined) {
    collectSkippedConfigPaths(featureModels, "ai.featureModelOverrides", skipped);
  }

  const customModelSlugs = value.customModelSlugs;
  if (Array.isArray(customModelSlugs)) {
    const safe = customModelSlugs.filter(
      (child): child is string => typeof child === "string" && child.trim().length > 0,
    ).map((child) => child.trim());
    if (safe.length) out.customModelSlugs = safe;
    if (safe.length !== customModelSlugs.length) {
      skipped.push("ai.customModelSlugs.invalid");
    }
  } else if (customModelSlugs !== undefined) {
    collectSkippedConfigPaths(customModelSlugs, "ai.customModelSlugs", skipped);
  }

  for (const key of ["modelId", "model", "defaultModel"] as const) {
    if (typeof value[key] === "string" && value[key]!.trim()) out[key] = value[key]!.trim();
    else if (value[key] !== undefined) collectSkippedConfigPaths(value[key], `ai.${key}`, skipped);
  }

  const session = value.sessionIntelligence;
  if (isRecord(session)) {
    const safeSession: Record<string, unknown> = {};
    for (const section of ["titles", "summaries"] as const) {
      const rawSection = session[section];
      if (rawSection === undefined) continue;
      if (!isRecord(rawSection)) {
        collectSkippedConfigPaths(rawSection, `ai.sessionIntelligence.${section}`, skipped);
        continue;
      }
      const safeSection: Record<string, unknown> = {};
      for (const field of ["enabled", "modelId"] as const) {
        const child = rawSection[field];
        if (typeof child === "boolean") safeSection[field] = child;
        else if (field === "modelId" && (child === null || (typeof child === "string" && child.trim()))) {
          safeSection[field] = typeof child === "string" ? child.trim() : child;
        } else if (child !== undefined) {
          collectSkippedConfigPaths(child, `ai.sessionIntelligence.${section}.${field}`, skipped);
        }
      }
      for (const [field, child] of Object.entries(rawSection)) {
        if (field !== "enabled" && field !== "modelId") {
          collectSkippedConfigPaths(child, `ai.sessionIntelligence.${section}.${field}`, skipped);
        }
      }
      if (Object.keys(safeSection).length) safeSession[section] = safeSection;
    }
    for (const [section, child] of Object.entries(session)) {
      if (section !== "titles" && section !== "summaries") {
        collectSkippedConfigPaths(child, `ai.sessionIntelligence.${section}`, skipped);
      }
    }
    if (Object.keys(safeSession).length) out.sessionIntelligence = safeSession;
  } else if (session !== undefined) {
    collectSkippedConfigPaths(session, "ai.sessionIntelligence", skipped);
  }

  const localProviders = value.localProviders;
  if (isRecord(localProviders)) {
    const safeProviders: Record<string, unknown> = {};
    for (const [provider, rawProvider] of Object.entries(localProviders)) {
      if (!isRecord(rawProvider)) {
        collectSkippedConfigPaths(rawProvider, `ai.localProviders.${provider}`, skipped);
        continue;
      }
      const safeProvider: Record<string, unknown> = {};
      for (const field of ["enabled", "autoDetect", "preferredModelId"] as const) {
        const child = rawProvider[field];
        if (typeof child === "boolean") safeProvider[field] = child;
        else if (field === "preferredModelId" && (child === null || (typeof child === "string" && child.trim()))) {
          safeProvider[field] = typeof child === "string" ? child.trim() : child;
        } else if (child !== undefined) {
          collectSkippedConfigPaths(child, `ai.localProviders.${provider}.${field}`, skipped);
        }
      }
      for (const [field, child] of Object.entries(rawProvider)) {
        if (field !== "enabled" && field !== "autoDetect" && field !== "preferredModelId") {
          collectSkippedConfigPaths(child, `ai.localProviders.${provider}.${field}`, skipped);
        }
      }
      if (Object.keys(safeProvider).length) safeProviders[provider] = safeProvider;
    }
    if (Object.keys(safeProviders).length) out.localProviders = safeProviders;
  } else if (localProviders !== undefined) {
    collectSkippedConfigPaths(localProviders, "ai.localProviders", skipped);
  }

  const taskRouting = value.taskRouting;
  if (isRecord(taskRouting)) {
    const safeRouting: Record<string, unknown> = {};
    for (const [task, rawRule] of Object.entries(taskRouting)) {
      if (!isRecord(rawRule)) {
        collectSkippedConfigPaths(rawRule, `ai.taskRouting.${task}`, skipped);
        continue;
      }
      if (typeof rawRule.model === "string" && rawRule.model.trim()) {
        safeRouting[task] = { model: rawRule.model.trim() };
      }
      for (const [field, child] of Object.entries(rawRule)) {
        if (field !== "model") collectSkippedConfigPaths(child, `ai.taskRouting.${task}.${field}`, skipped);
      }
    }
    if (Object.keys(safeRouting).length) out.taskRouting = safeRouting;
  } else if (taskRouting !== undefined) {
    collectSkippedConfigPaths(taskRouting, "ai.taskRouting", skipped);
  }

  const orchestrator = value.orchestrator;
  if (isRecord(orchestrator)) {
    const rawModel = orchestrator.defaultOrchestratorModel;
    if (isRecord(rawModel) && typeof rawModel.modelId === "string" && rawModel.modelId.trim()) {
      out.orchestrator = { defaultOrchestratorModel: { modelId: rawModel.modelId.trim() } };
    }
    for (const [field, child] of Object.entries(orchestrator)) {
      if (field !== "defaultOrchestratorModel") {
        collectSkippedConfigPaths(child, `ai.orchestrator.${field}`, skipped);
      }
    }
    if (rawModel !== undefined) {
      if (!isRecord(rawModel) || typeof rawModel.modelId !== "string" || !rawModel.modelId.trim()) {
        collectSkippedConfigPaths(rawModel, "ai.orchestrator.defaultOrchestratorModel", skipped);
      } else {
        for (const [field, child] of Object.entries(rawModel)) {
          if (field !== "modelId") collectSkippedConfigPaths(child, `ai.orchestrator.defaultOrchestratorModel.${field}`, skipped);
        }
      }
    }
  } else if (orchestrator !== undefined) {
    collectSkippedConfigPaths(orchestrator, "ai.orchestrator", skipped);
  }

  return { value: Object.keys(out).length ? out : undefined, skipped };
}
