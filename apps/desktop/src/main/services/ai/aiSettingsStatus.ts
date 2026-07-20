import type {
  AiFeatureKey,
  AiSettingsStatus,
} from "../../../shared/types";

export const AI_USAGE_FEATURE_KEYS: AiFeatureKey[] = [
  "narratives",
  "conflict_proposals",
  "commit_messages",
  "pr_descriptions",
  "terminal_summaries",
  "orchestrator",
  "initial_context",
];

type AiSettingsStatusSource = {
  getStatus(args?: { force?: boolean; refreshOpenCodeInventory?: boolean }): Promise<Omit<AiSettingsStatus, "features"> & Partial<Pick<AiSettingsStatus, "features">>>;
  getDailyUsageBatch(features: AiFeatureKey[]): Map<AiFeatureKey, number>;
  getFeatureFlag(feature: AiFeatureKey): boolean;
  getDailyBudgetLimit(feature: AiFeatureKey): number | null;
};

export function isDatabaseClosedError(error: unknown): boolean {
  return error instanceof Error && /database closed/i.test(error.message);
}

export function getUnavailableAiStatus(): AiSettingsStatus {
  return {
    mode: "guest",
    availableProviders: {
      claude: {
        binary: {
          present: false,
          source: "missing",
          path: null,
        },
        auth: {
          ready: false,
          mode: "none",
          detail: "AI integration service unavailable.",
        },
      },
      codex: false,
      cursor: false,
      droid: false,
    },
    models: {
      claude: [],
      codex: [],
      cursor: [],
      droid: [],
    },
    detectedAuth: [],
    providerConnections: {
      claude: {
        provider: "claude",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
      codex: {
        provider: "codex",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
      cursor: {
        provider: "cursor",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
      droid: {
        provider: "droid",
        authAvailable: false,
        runtimeDetected: false,
        runtimeAvailable: false,
        usageAvailable: false,
        path: null,
        blocker: "AI integration service unavailable.",
        lastCheckedAt: new Date(0).toISOString(),
        sources: [],
      },
    },
    features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
      feature,
      enabled: false,
      dailyUsage: 0,
      dailyLimit: null,
    })),
    runtimeConnections: {},
    availableModelIds: [],
    opencodeBinaryInstalled: false,
    opencodeBinarySource: "missing",
    opencodeInventoryError: null,
    opencodeProviders: [],
    opencodeProvidersStale: false,
    modelsDevLastFetchedAt: null,
  };
}

export async function buildAiSettingsStatus(
  service: AiSettingsStatusSource | null | undefined,
  args?: { force?: boolean; refreshOpenCodeInventory?: boolean },
): Promise<AiSettingsStatus> {
  if (!service) {
    return getUnavailableAiStatus();
  }
  const status = await service.getStatus({
    force: args?.force === true,
    refreshOpenCodeInventory: args?.refreshOpenCodeInventory === true,
  });
  const usageBatch = service.getDailyUsageBatch(AI_USAGE_FEATURE_KEYS);
  return {
    mode: status.mode,
    availableProviders: status.availableProviders,
    models: status.models,
    detectedAuth: status.detectedAuth,
    providerConnections: status.providerConnections,
    runtimeConnections: status.runtimeConnections,
    availableModelIds: status.availableModelIds,
    opencodeBinaryInstalled: status.opencodeBinaryInstalled,
    opencodeBinarySource: status.opencodeBinarySource,
    opencodeInventoryError: status.opencodeInventoryError,
    opencodeProviders: status.opencodeProviders,
    opencodeProvidersStale: status.opencodeProvidersStale,
    modelsDevLastFetchedAt: status.modelsDevLastFetchedAt,
    customProviders: status.customProviders,
    customModelSlugs: status.customModelSlugs,
    apiKeyStore: status.apiKeyStore,
    features: AI_USAGE_FEATURE_KEYS.map((feature) => ({
      feature,
      enabled: service.getFeatureFlag(feature),
      dailyUsage: usageBatch.get(feature) ?? 0,
      dailyLimit: service.getDailyBudgetLimit(feature),
    })),
  };
}
