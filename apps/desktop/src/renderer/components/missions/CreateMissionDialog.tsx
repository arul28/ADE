import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Rocket,
  X,
  Plus,
  SpinnerGap,
  GitBranch,
  ChatCircle,
  Robot,
  Hash,
  Warning,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type {
  MissionAgentRuntimeConfig,
  MissionModelConfig,
  PhaseCard,
  PhaseProfile,
  PrStrategy,
  PrDepth,
  OrchestratorDecisionTimeoutCapHours,
  AggregatedUsageStats,
  MissionBudgetTelemetrySnapshot,
  MergeMethod,
  TeamRuntimeConfig,
  MissionPermissionConfig,
} from "../../../shared/types";
import { BUILT_IN_PROFILES } from "../../../shared/modelProfiles";
import { getDefaultModelDescriptor, MODEL_REGISTRY, resolveModelDescriptor } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import { ModelSelector } from "./ModelSelector";
import { SmartBudgetPanel } from "./SmartBudgetPanel";
import { MissionPromptInput } from "./MissionPromptInput";
import { PhaseCardEditor } from "./PhaseCardEditor";
import { WorkerPermissionsEditor } from "./WorkerPermissionsEditor";
import { createBuiltInMissionPhaseCards, createBuiltInMissionPhaseProfiles } from "./missionPhaseDefaults";
import {
  getCachedPhaseItems,
  getCachedPhaseProfiles,
  hasFreshPhaseItems,
  hasFreshPhaseProfiles,
  setCachedPhaseItems,
  setCachedPhaseProfiles,
} from "./missionDialogDataCache";

export type CreateDraft = {
  title: string;
  prompt: string;
  laneId: string;
  priority: import("../../../shared/types").MissionPriority;
  prStrategy: PrStrategy;
  modelConfig: MissionModelConfig;
  phaseProfileId: string | null;
  phaseOverride: PhaseCard[];
  agentRuntime: MissionAgentRuntimeConfig;
  teamRuntime?: TeamRuntimeConfig;
  permissionConfig: MissionPermissionConfig;
};

export type CreateMissionDefaults = {
  plannerProvider?: "auto" | "claude" | "codex";
  orchestratorModel?: import("../../../shared/types").ModelConfig;
  permissionConfig?: MissionPermissionConfig;
};

const DEFAULT_AGENT_RUNTIME: MissionAgentRuntimeConfig = {
  allowParallelAgents: true,
  allowSubAgents: true,
  allowClaudeAgentTeams: true,
};

const DECISION_TIMEOUT_CAP_OPTIONS: OrchestratorDecisionTimeoutCapHours[] = [6, 12, 24, 48];

const DEFAULT_ORCHESTRATOR_MODEL_BY_PROVIDER: Record<"claude" | "codex", MissionModelConfig["orchestratorModel"]> = {
  claude: { provider: "claude", modelId: getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
  codex: { provider: "codex", modelId: getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.3-codex", thinkingLevel: "medium" },
};

const HIGH_TEAMMATE_COUNT_GUARDRAIL_THRESHOLD = 5;
const CREATE_DIALOG_CACHE_TTL_MS = 60_000;
const CREATE_DIALOG_PREWARM_DELAY_MS = 300;
const CREATE_DIALOG_PHASE_SYNC_DELAY_MS = 1_500;

type CreateMissionDialogAiStatusCache = {
  availableModelIds?: string[];
  detectedAuth: import("../../../shared/types").AiDetectedAuth[] | null;
};

const createMissionDialogCache: {
  aiStatus: CreateMissionDialogAiStatusCache | null;
  aiStatusCachedAt: number;
} = {
  aiStatus: null,
  aiStatusCachedAt: 0,
};

function hasFreshCreateDialogCache(cachedAt: number): boolean {
  return cachedAt > 0 && Date.now() - cachedAt < CREATE_DIALOG_CACHE_TTL_MS;
}

function getDefaultPhaseProfile(profiles: PhaseProfile[]): PhaseProfile | null {
  return profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
}

function cloneProfilePhases(profile: PhaseProfile | null): PhaseCard[] {
  if (!profile) return [];
  return profile.phases.map((phase, index) => ({ ...phase, position: index }));
}

function buildDefaultModelConfig(
  defaults: CreateMissionDefaults | null | undefined,
  builtInProfiles: typeof BUILT_IN_PROFILES = BUILT_IN_PROFILES,
): MissionModelConfig {
  void builtInProfiles;
  const plannerProvider = defaults?.plannerProvider ?? "auto";

  // Prefer explicit orchestratorModel from settings, fall back to provider-based default
  const orchestratorModel = defaults?.orchestratorModel
    ?? (plannerProvider === "claude" || plannerProvider === "codex"
      ? DEFAULT_ORCHESTRATOR_MODEL_BY_PROVIDER[plannerProvider]
      : DEFAULT_ORCHESTRATOR_MODEL_BY_PROVIDER.claude);

  return {
    profileId: undefined,
    orchestratorModel,
    decisionTimeoutCapHours: 24,
    intelligenceConfig: undefined,
    smartBudget: { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 },
  };
}

function createDefaultPermissionConfig(defaults: CreateMissionDefaults | null | undefined): MissionPermissionConfig {
  if (defaults?.permissionConfig?.providers) {
    return { ...defaults.permissionConfig };
  }
  return {
    providers: {
      claude: "full-auto",
      codex: "full-auto",
      unified: "full-auto",
      codexSandbox: "workspace-write",
    },
  };
}

export function resolveLaunchLaneId(args: { draftLaneId: string; defaultLaneId?: string | null }): string {
  const explicit = args.draftLaneId.trim();
  if (explicit.length > 0) return explicit;
  const fallback = String(args.defaultLaneId ?? "").trim();
  return fallback;
}

export function buildCreateMissionDraft(
  defaults: CreateMissionDefaults | null | undefined,
  builtInProfiles: typeof BUILT_IN_PROFILES = BUILT_IN_PROFILES,
): CreateDraft {
  return {
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    prStrategy: { kind: "integration", targetBranch: "main", draft: true },
    modelConfig: buildDefaultModelConfig(defaults, builtInProfiles),
    phaseProfileId: null,
    phaseOverride: [],
    agentRuntime: { ...DEFAULT_AGENT_RUNTIME },
    permissionConfig: createDefaultPermissionConfig(defaults),
  };
}

function validatePhaseOrder(cards: PhaseCard[]): string[] {
  if (!cards.length) return ["At least one phase is required."];
  const errors: string[] = [];
  const byKey = new Map<string, number>();
  let firstDevelopmentIndex = -1;
  let firstPlanningIndex = -1;
  cards.forEach((card, index) => {
    const phaseKey = card.phaseKey.trim().toLowerCase();
    if (!phaseKey) errors.push(`Phase ${index + 1} is missing a key.`);
    if (byKey.has(phaseKey)) errors.push(`Duplicate phase key: ${card.phaseKey}`);
    byKey.set(phaseKey, index);
    if (phaseKey === "development" && firstDevelopmentIndex < 0) firstDevelopmentIndex = index;
    if (phaseKey === "planning" && firstPlanningIndex < 0) firstPlanningIndex = index;
  });
  if (!byKey.has("development")) errors.push("Development phase is required.");
  if (firstPlanningIndex >= 0 && firstDevelopmentIndex >= 0 && firstPlanningIndex > firstDevelopmentIndex) {
    errors.push("Planning phase must appear before development.");
  }
  return [...new Set(errors)];
}

const DLG_INPUT_STYLE: React.CSSProperties = { background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 };
const DLG_LABEL_STYLE: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

// ---------------------------------------------------------------------------
// Worker Permissions — thin wrapper around extracted WorkerPermissionsEditor
// ---------------------------------------------------------------------------

function WorkerPermissionsSection({
  draft,
  activePhases,
  setDraft,
  dlgLabelStyle,
  dlgInputStyle,
}: {
  draft: CreateDraft;
  activePhases: PhaseCard[];
  setDraft: React.Dispatch<React.SetStateAction<CreateDraft>>;
  dlgLabelStyle: React.CSSProperties;
  dlgInputStyle: React.CSSProperties;
}) {
  return (
    <WorkerPermissionsEditor
      orchestratorModelId={draft.modelConfig.orchestratorModel?.modelId}
      phases={activePhases}
      permissionConfig={draft.permissionConfig}
      onPermissionChange={(next) => setDraft((p) => ({ ...p, permissionConfig: next }))}
      labelStyle={dlgLabelStyle}
      inputStyle={dlgInputStyle}
    />
  );
}

function CreateMissionDialogInner({
  open,
  onClose,
  onLaunch,
  busy,
  lanes,
  defaultLaneId,
  missionDefaults,
  resetVersion,
}: {
  open: boolean;
  onClose: () => void;
  onLaunch: (draft: CreateDraft) => void;
  busy: boolean;
  lanes: Array<{ id: string; name: string }>;
  defaultLaneId?: string | null;
  missionDefaults?: CreateMissionDefaults | null;
  resetVersion?: number;
}) {
  const sortedLanes = useMemo(
    () => [...lanes].sort((a, b) => a.name.localeCompare(b.name)),
    [lanes]
  );
  const initialDraft = useMemo(() => buildCreateMissionDraft(missionDefaults), [missionDefaults]);
  const builtInPhaseCards = useMemo(() => createBuiltInMissionPhaseCards(), []);
  const builtInPhaseProfiles = useMemo(
    () => createBuiltInMissionPhaseProfiles(builtInPhaseCards),
    [builtInPhaseCards]
  );
  const [hasMountedBody, setHasMountedBody] = useState(open);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [phaseProfiles, setPhaseProfiles] = useState<PhaseProfile[]>(() => {
    const cachedProfiles = getCachedPhaseProfiles();
    return cachedProfiles?.length ? cachedProfiles : builtInPhaseProfiles;
  });
  const [phaseLoading, setPhaseLoading] = useState(false);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>({});
  const [disabledPhases, setDisabledPhases] = useState<Record<string, boolean>>({});
  const [availableModelIds, setAvailableModelIds] = useState<string[] | undefined>(() => createMissionDialogCache.aiStatus?.availableModelIds);
  const [aiDetectedAuth, setAiDetectedAuth] = useState<import("../../../shared/types").AiDetectedAuth[] | null>(() => createMissionDialogCache.aiStatus?.detectedAuth ?? null);
  const [currentUsage, setCurrentUsage] = useState<AggregatedUsageStats | null>(null);
  const [weeklyUsage, setWeeklyUsage] = useState<AggregatedUsageStats | null>(null);
  const [budgetTelemetry, setBudgetTelemetry] = useState<MissionBudgetTelemetrySnapshot | null>(null);
  const [phaseItems, setPhaseItems] = useState<PhaseCard[]>(() => getCachedPhaseItems() ?? []);
  const [phaseItemsLoading, setPhaseItemsLoading] = useState(false);
  const [phaseItemsError, setPhaseItemsError] = useState<string | null>(null);
  const [selectedPhaseItemKey, setSelectedPhaseItemKey] = useState<string>("");
  const [phaseNotice, setPhaseNotice] = useState<string | null>(null);
  const [teamBudgetGuardrailConfirmed, setTeamBudgetGuardrailConfirmed] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(initialDraft);
  const [nonCriticalReady, setNonCriticalReady] = useState(false);
  const initializedResetVersionRef = useRef<number | undefined>(undefined);
  const phaseDataSyncStartedRef = useRef(false);

  useEffect(() => {
    if (hasMountedBody) return;
    if (open) {
      setHasMountedBody(true);
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setHasMountedBody(true);
    }, CREATE_DIALOG_PREWARM_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [hasMountedBody, open]);

  useEffect(() => {
    if (!open) return;
    if (initializedResetVersionRef.current === resetVersion) return;
    initializedResetVersionRef.current = resetVersion;
    const cachedProfiles = getCachedPhaseProfiles();
    const fallbackProfiles = cachedProfiles?.length ? cachedProfiles : builtInPhaseProfiles;
    const cachedItems = getCachedPhaseItems() ?? [];
    const resetDraft = buildCreateMissionDraft(missionDefaults);
    const defaultCachedProfile = getDefaultPhaseProfile(fallbackProfiles);
    if (defaultCachedProfile) {
      resetDraft.phaseProfileId = defaultCachedProfile.id;
      resetDraft.phaseOverride = cloneProfilePhases(defaultCachedProfile);
    }
    setAttachments([]);
    setPhaseError(null);
    setPhaseNotice(null);
    setPhaseItemsError(null);
    setSelectedPhaseItemKey("");
    setExpandedPhases({});
    setDisabledPhases({});
    setTeamBudgetGuardrailConfirmed(false);
    setDraft(resetDraft);
    setPhaseProfiles(fallbackProfiles);
    setPhaseItems(cachedItems);
    setAvailableModelIds(
      hasFreshCreateDialogCache(createMissionDialogCache.aiStatusCachedAt)
        ? createMissionDialogCache.aiStatus?.availableModelIds
        : undefined
    );
    setAiDetectedAuth(
      hasFreshCreateDialogCache(createMissionDialogCache.aiStatusCachedAt)
        ? createMissionDialogCache.aiStatus?.detectedAuth ?? null
        : null
    );
    setPhaseLoading(false);
    setPhaseItemsLoading(false);
  }, [open, missionDefaults, resetVersion, builtInPhaseProfiles]);

  useEffect(() => {
    if (!open) {
      setNonCriticalReady(false);
      return;
    }
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        setNonCriticalReady(true);
      }
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [open]);

  useEffect(() => {
    if (!hasMountedBody || phaseDataSyncStartedRef.current) return;
    const shouldRefreshProfiles = !hasFreshPhaseProfiles();
    const shouldRefreshItems = !hasFreshPhaseItems();
    if (!shouldRefreshProfiles && !shouldRefreshItems) return;

    phaseDataSyncStartedRef.current = true;
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      if (shouldRefreshProfiles) setPhaseLoading(true);
      if (shouldRefreshItems) setPhaseItemsLoading(true);

      if (shouldRefreshProfiles) {
        void window.ade.missions
          .listPhaseProfiles({})
          .then((profiles) => {
            if (cancelled) return;
            const nextProfiles = profiles.length > 0 ? profiles : builtInPhaseProfiles;
            setCachedPhaseProfiles(nextProfiles);
            setPhaseProfiles(nextProfiles);
            const defaultProfile = getDefaultPhaseProfile(nextProfiles);
            setDraft((prev) => {
              if (prev.phaseOverride.length > 0) return prev;
              return {
                ...prev,
                phaseProfileId: defaultProfile?.id ?? null,
                phaseOverride: cloneProfilePhases(defaultProfile),
              };
            });
          })
          .catch((err) => {
            if (!cancelled) {
              setPhaseError(err instanceof Error ? err.message : String(err));
            }
          })
          .finally(() => {
            if (!cancelled) setPhaseLoading(false);
          });
      }

      if (shouldRefreshItems) {
        void window.ade.missions
          .listPhaseItems({})
          .then((items) => {
            if (cancelled) return;
            setCachedPhaseItems(items);
            setPhaseItems(items);
          })
          .catch((err) => {
            if (!cancelled) {
              setPhaseItemsError(err instanceof Error ? err.message : String(err));
            }
          })
          .finally(() => {
            if (!cancelled) setPhaseItemsLoading(false);
          });
      }
    }, CREATE_DIALOG_PHASE_SYNC_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [hasMountedBody, builtInPhaseProfiles]);

  useEffect(() => {
    if (!open || !nonCriticalReady || hasFreshCreateDialogCache(createMissionDialogCache.aiStatusCachedAt)) return;
    let cancelled = false;

    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      void window.ade.ai.getStatus().then((status) => {
        if (cancelled) return;
        const ids: string[] = [];
        const auth = status.detectedAuth ?? [];
        for (const entry of auth) {
          if (!entry.authenticated) continue;
          if (entry.type === "cli-subscription" && entry.cli) {
            const familyMap: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };
            const family = familyMap[entry.cli];
            if (family) {
              for (const model of MODEL_REGISTRY) {
                if (model.family === family && !model.deprecated) ids.push(model.id);
              }
            }
          }
          if (entry.type === "api-key" && entry.provider) {
            for (const model of MODEL_REGISTRY) {
              if (model.family === entry.provider && !model.deprecated) ids.push(model.id);
            }
          }
        }
        const cachedStatus: CreateMissionDialogAiStatusCache = {
          detectedAuth: auth,
          availableModelIds: ids.length > 0 ? [...new Set(ids)] : undefined,
        };
        createMissionDialogCache.aiStatus = cachedStatus;
        createMissionDialogCache.aiStatusCachedAt = Date.now();
        setAiDetectedAuth(cachedStatus.detectedAuth);
        setAvailableModelIds(cachedStatus.availableModelIds);
      }).catch(() => {
        if (!cancelled) setAvailableModelIds(undefined);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [open, nonCriticalReady]);

  const activePhases = useMemo(() => {
    const enabled = draft.phaseOverride
      .filter((phase) => !disabledPhases[phase.id])
      .map((phase, index) => ({ ...phase, position: index }));
    const activeKeys = new Set(
      enabled.map((phase) => phase.phaseKey.trim().toLowerCase()).filter((key) => key.length > 0)
    );
    return enabled.map((phase, index) => {
      const constraints = phase.orderingConstraints ?? {};
      return {
        ...phase,
        position: index,
        orderingConstraints: {
          ...constraints,
          mustFollow: Array.isArray(constraints.mustFollow)
            ? constraints.mustFollow.filter((entry) => activeKeys.has(String(entry ?? "").trim().toLowerCase()))
            : [],
          mustPrecede: Array.isArray(constraints.mustPrecede)
            ? constraints.mustPrecede.filter((entry) => activeKeys.has(String(entry ?? "").trim().toLowerCase()))
            : [],
        },
      };
    });
  }, [draft.phaseOverride, disabledPhases]);

  const selectedBudgetFamilies = useMemo(() => {
    const subscriptionProviders = new Set<"claude" | "codex">();
    let hasApiModels = false;
    const inspectModel = (rawModelId: string | null | undefined): void => {
      const modelId = String(rawModelId ?? "").trim();
      if (!modelId.length) return;
      const descriptor = resolveModelDescriptor(modelId);
      if (!descriptor) {
        hasApiModels = true;
        return;
      }
      if (descriptor.isCliWrapped && descriptor.family === "anthropic") {
        subscriptionProviders.add("claude");
        return;
      }
      if (descriptor.isCliWrapped && descriptor.family === "openai") {
        subscriptionProviders.add("codex");
        return;
      }
      if (descriptor.authTypes.includes("api-key") || descriptor.authTypes.includes("openrouter")) {
        hasApiModels = true;
      }
    };
    for (const phase of activePhases) inspectModel(phase.model.modelId);
    inspectModel(draft.modelConfig.orchestratorModel?.modelId);
    return {
      subscriptionProviders: [...subscriptionProviders].sort(),
      hasApiModels,
    };
  }, [activePhases, draft.modelConfig.orchestratorModel?.modelId]);

  useEffect(() => {
    if (!open || !nonCriticalReady) {
      setBudgetTelemetry(null);
      setCurrentUsage(null);
      setWeeklyUsage(null);
      return;
    }
    let cancelled = false;
    if (selectedBudgetFamilies.subscriptionProviders.length > 0) {
      void window.ade.orchestrator.getMissionBudgetTelemetry({
        providers: selectedBudgetFamilies.subscriptionProviders,
      }).then((snapshot) => {
        if (!cancelled) setBudgetTelemetry(snapshot);
      }).catch(() => {
        if (!cancelled) setBudgetTelemetry(null);
      });
    } else {
      setBudgetTelemetry(null);
    }
    if (!selectedBudgetFamilies.hasApiModels) {
      setCurrentUsage(null);
      setWeeklyUsage(null);
      return () => {
        cancelled = true;
      };
    }
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    void window.ade.orchestrator.getAggregatedUsage({ since: fiveHoursAgo }).then((stats) => {
      if (!cancelled) setCurrentUsage(stats);
    }).catch(() => {
      if (!cancelled) setCurrentUsage(null);
    });
    void window.ade.orchestrator.getAggregatedUsage({ since: oneWeekAgo }).then((stats) => {
      if (!cancelled) setWeeklyUsage(stats);
    }).catch(() => {
      if (!cancelled) setWeeklyUsage(null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    nonCriticalReady,
    selectedBudgetFamilies.hasApiModels,
    selectedBudgetFamilies.subscriptionProviders,
  ]);

  const launcherPerProviderUsage = useMemo(() => {
    if (!budgetTelemetry?.perProvider?.length) return undefined;
    const providerLimits = draft.modelConfig.smartBudget?.providerLimits ?? {};
    return budgetTelemetry.perProvider.map((providerSnapshot) => {
      const limits = providerLimits[providerSnapshot.provider];
      const fiveHourLimit = typeof limits?.fiveHourTokenLimit === "number"
        ? limits.fiveHourTokenLimit
        : null;
      const weeklyLimit = typeof limits?.weeklyTokenLimit === "number"
        ? limits.weeklyTokenLimit
        : null;
      const fiveHourPct = fiveHourLimit != null && fiveHourLimit > 0
        ? Number(((providerSnapshot.fiveHour.usedTokens / fiveHourLimit) * 100).toFixed(1))
        : null;
      const weeklyPct = weeklyLimit != null && weeklyLimit > 0
        ? Number(((providerSnapshot.weekly.usedTokens / weeklyLimit) * 100).toFixed(1))
        : null;
      return {
        provider: providerSnapshot.provider,
        fiveHour: {
          ...providerSnapshot.fiveHour,
          limitTokens: fiveHourLimit,
          usedPct: fiveHourPct,
        },
        weekly: {
          ...providerSnapshot.weekly,
          limitTokens: weeklyLimit,
          usedPct: weeklyPct,
        },
      };
    });
  }, [budgetTelemetry, draft.modelConfig.smartBudget?.providerLimits]);

  const phaseValidationErrors = useMemo(() => validatePhaseOrder(activePhases), [activePhases]);
  const customPhaseItems = useMemo(
    () => phaseItems.filter((item) => !item.isBuiltIn),
    [phaseItems]
  );

  const appendPhaseFromItem = useCallback((item: PhaseCard) => {
    setDraft((prev) => {
      const usedKeys = new Set(
        prev.phaseOverride.map((phase) => phase.phaseKey.trim().toLowerCase()).filter((key) => key.length > 0)
      );
      const baseKey = item.phaseKey.trim().length > 0
        ? item.phaseKey.trim()
        : `custom_${prev.phaseOverride.length + 1}`;
      let phaseKey = baseKey;
      let suffix = 2;
      while (usedKeys.has(phaseKey.toLowerCase())) {
        phaseKey = `${baseKey}_${suffix}`;
        suffix += 1;
      }
      const now = new Date().toISOString();
      return {
        ...prev,
        phaseOverride: [
          ...prev.phaseOverride,
          {
            ...item,
            id: `custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            phaseKey,
            isBuiltIn: false,
            isCustom: true,
            position: prev.phaseOverride.length,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    });
  }, []);

  const billingContext = useMemo(() => {
    if (!aiDetectedAuth?.length) return undefined;
    const subProviders: string[] = [];
    const apiProviders: string[] = [];
    for (const auth of aiDetectedAuth) {
      if (!auth.authenticated) continue;
      if (auth.type === "cli-subscription" && auth.cli) {
        const familyMap: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };
        if (familyMap[auth.cli]) subProviders.push(familyMap[auth.cli]!);
      }
      if (auth.type === "api-key" && auth.provider) {
        apiProviders.push(auth.provider);
      }
    }
    return {
      hasSubscription: subProviders.length > 0,
      subscriptionProviders: [...new Set(subProviders)],
      apiProviders: [...new Set(apiProviders)],
    };
  }, [aiDetectedAuth]);

  const teamBudgetGuardrailTeammateCount = draft.teamRuntime?.enabled
    ? Math.max(1, draft.teamRuntime.teammateCount ?? 2)
    : 0;
  const teamBudgetGuardrailActive = teamBudgetGuardrailTeammateCount >= HIGH_TEAMMATE_COUNT_GUARDRAIL_THRESHOLD
    && draft.modelConfig.smartBudget?.enabled !== true;
  const teamBudgetGuardrailEnabled = draft.teamRuntime?.enabled === true;
  const teamBudgetGuardrailSmartBudget = draft.modelConfig.smartBudget?.enabled === true;

  useEffect(() => {
    setTeamBudgetGuardrailConfirmed(false);
  }, [teamBudgetGuardrailEnabled, teamBudgetGuardrailTeammateCount, teamBudgetGuardrailSmartBudget]);

  const handleLaunch = useCallback(() => {
    if (!draft.prompt.trim()) return;
    if (validatePhaseOrder(activePhases).length > 0) return;
    const resolvedLaneId = resolveLaunchLaneId({
      draftLaneId: draft.laneId,
      defaultLaneId
    });
    if (teamBudgetGuardrailActive && !teamBudgetGuardrailConfirmed) {
      const confirmed = window.confirm(
        `Team runtime is configured with ${teamBudgetGuardrailTeammateCount} teammates while Smart Budget is disabled. This can increase token/cost burn quickly. Continue?`
      );
      if (!confirmed) return;
      setTeamBudgetGuardrailConfirmed(true);
    }
    onLaunch({ ...draft, laneId: resolvedLaneId, phaseOverride: activePhases });
  }, [
    draft,
    activePhases,
    onLaunch,
    teamBudgetGuardrailActive,
    teamBudgetGuardrailConfirmed,
    teamBudgetGuardrailTeammateCount,
    defaultLaneId,
  ]);

  const shouldRenderBody = hasMountedBody || open;
  if (!shouldRenderBody) return null;

  const dlgInputStyle = DLG_INPUT_STYLE;
  const dlgLabelStyle = DLG_LABEL_STYLE;

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 transition-opacity duration-150 ${
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
      style={{ visibility: open ? "visible" : "hidden" }}
      onClick={() => {
        if (busy) return;
        onClose();
      }}
    >
      <motion.div
        initial={false}
        animate={{
          opacity: open ? 1 : 0,
          scale: open ? 1 : 0.98,
          transition: { duration: open ? 0.15 : 0.1 },
        }}
        className="w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
        style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 h-14" style={{ background: COLORS.recessedBg, borderBottom: `1px solid ${COLORS.border}` }}>
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4" style={{ color: COLORS.accent }} />
            <h2 className="text-sm font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>NEW MISSION</h2>
          </div>
          <button onClick={onClose} className="transition-colors" style={{ color: COLORS.textMuted }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 1. Mission Prompt */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>
              <ChatCircle size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              MISSION PROMPT *
            </span>
            <MissionPromptInput
              value={draft.prompt}
              onChange={(v) => setDraft((p) => ({ ...p, prompt: v }))}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          </div>

          {/* 2. Title */}
          <label className="block space-y-1">
            <span style={dlgLabelStyle}>TITLE (OPTIONAL)</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
              placeholder="e.g. Refactor auth middleware"
              className="h-8 w-full px-3 text-xs outline-none"
              style={dlgInputStyle}
            />
          </label>

          {/* 3. Base Lane */}
          <label className="block space-y-1">
            <span style={dlgLabelStyle}>
              <GitBranch size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              BASE LANE
            </span>
            <select
              value={draft.laneId}
              onChange={(e) => setDraft((p) => ({ ...p, laneId: e.target.value }))}
              className="h-8 w-full px-3 text-xs outline-none"
              style={dlgInputStyle}
            >
              <option value="">Primary lane (auto)</option>
              {sortedLanes.map((lane) => (
                <option key={lane.id} value={lane.id}>{lane.name}</option>
              ))}
            </select>
          </label>

          <div style={{ borderTop: `1px solid ${COLORS.border}`, margin: "4px 0" }} />

          {/* 4. Orchestrator Model */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>
              <Robot size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              ORCHESTRATOR MODEL
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <ModelSelector
                  value={draft.modelConfig.orchestratorModel}
                  onChange={(config) => {
                    setDraft((p) => ({
                      ...p,
                      modelConfig: { ...p.modelConfig, profileId: undefined, orchestratorModel: config },
                    }));
                  }}
                  showRecommendedBadge
                  availableModelIds={availableModelIds}
                />
              </div>
              {aiDetectedAuth && (
                <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
                  {(() => {
                    const providers = new Map<string, boolean>();
                    for (const a of aiDetectedAuth) {
                      const label = a.cli ?? a.provider ?? a.type;
                      if (label && !providers.has(label)) {
                        providers.set(label, !!a.authenticated);
                      }
                    }
                    return Array.from(providers.entries()).map(([label, authed]) => (
                      <span
                        key={label}
                        title={`${label}: ${authed ? "authenticated" : "not detected"}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 9,
                          fontFamily: MONO_FONT,
                          color: authed ? COLORS.success : COLORS.danger,
                        }}
                      >
                        <span style={{
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          background: authed ? COLORS.success : COLORS.danger,
                          display: "inline-block",
                        }} />
                        {label}
                      </span>
                    ));
                  })()}
                </div>
              )}
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${COLORS.border}`, margin: "4px 0" }} />

          {/* 5. Additional Options */}
          <div className="space-y-3">
                {/* Decision Timeout Cap */}
                <label className="block space-y-1">
                  <span style={dlgLabelStyle}>DECISION TIMEOUT CAP</span>
                  <select
                    value={draft.modelConfig.decisionTimeoutCapHours ?? 24}
                    onChange={(e) => {
                      setDraft((p) => ({
                        ...p,
                        modelConfig: {
                          ...p.modelConfig,
                          profileId: undefined,
                          decisionTimeoutCapHours: Number(e.target.value) as OrchestratorDecisionTimeoutCapHours
                        }
                      }));
                    }}
                    className="h-8 w-full px-3 text-xs outline-none"
                    style={dlgInputStyle}
                  >
                    {DECISION_TIMEOUT_CAP_OPTIONS.map((hours) => (
                      <option key={hours} value={hours}>
                        {hours}h
                      </option>
                    ))}
                  </select>
                </label>

                {/* c. PR Strategy + Depth */}
                <div className="space-y-1">
                  <span style={dlgLabelStyle}>
                    <GitBranch size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
                    PR STRATEGY
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {(["integration", "per-lane", "queue", "manual"] as const).map((kind) => {
                      const labels: Record<string, string> = {
                        integration: "INTEGRATION",
                        "per-lane": "PER-LANE",
                        queue: "QUEUE",
                        manual: "MANUAL",
                      };
                      const strategyColors: Record<string, string> = {
                        integration: "#8B5CF6",
                        "per-lane": "#3B82F6",
                        queue: "#F59E0B",
                        manual: "#71717A",
                      };
                      const accentColor = strategyColors[kind];
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => {
                            if (kind === "manual") {
                              setDraft((p) => ({ ...p, prStrategy: { kind: "manual" as const } }));
                            } else if (kind === "queue") {
                              setDraft((p) => ({
                                ...p,
                                prStrategy: {
                                  kind: "queue" as const,
                                  targetBranch: (p.prStrategy.kind !== "manual" && "targetBranch" in p.prStrategy ? p.prStrategy.targetBranch : undefined) ?? "main",
                                  draft: p.prStrategy.kind !== "manual" && "draft" in p.prStrategy ? p.prStrategy.draft : true,
                                  autoRebase: true,
                                  ciGating: true,
                                  autoLand: false,
                                  rehearseQueue: false,
                                  autoResolveConflicts: false,
                                  archiveLaneOnLand: false,
                                  mergeMethod: "squash" as MergeMethod,
                                }
                              }));
                            } else {
                              const prevTarget = (p: CreateDraft) => p.prStrategy.kind !== "manual" && "targetBranch" in p.prStrategy ? p.prStrategy.targetBranch : "main";
                              const prevDraft = (p: CreateDraft) => p.prStrategy.kind !== "manual" && "draft" in p.prStrategy ? p.prStrategy.draft : true;
                              setDraft((p) => ({
                                ...p,
                                prStrategy: { kind, targetBranch: prevTarget(p) ?? "main", draft: prevDraft(p) ?? true }
                              }));
                            }
                          }}
                          className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-[1px] transition-colors"
                          title={kind === "manual"
                            ? "Complete mission without PR automation."
                            : kind === "integration"
                              ? "Create one integration PR flow at mission end."
                              : kind === "per-lane"
                                ? "Create one PR per lane at mission end."
                                : "Use queue-based PR automation at mission end."
                          }
                          style={draft.prStrategy.kind === kind
                            ? { background: `${accentColor}18`, color: accentColor, border: `1px solid ${accentColor}30`, fontFamily: MONO_FONT }
                            : { background: COLORS.recessedBg, color: COLORS.textMuted, border: `1px solid ${COLORS.border}`, fontFamily: MONO_FONT }
                          }
                        >
                          {labels[kind]}
                        </button>
                      );
                    })}
                  </div>
                  <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    Applied after mission work completes. This is not a phase card.
                  </div>
                  {draft.prStrategy.kind !== "manual" && (
                    <div className="flex items-center gap-3 mt-1">
                      <label className="flex items-center gap-1.5 text-[10px]">
                        <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>Target branch</span>
                        <input
                          value={"targetBranch" in draft.prStrategy ? draft.prStrategy.targetBranch ?? "main" : "main"}
                          onChange={(e) => {
                            const branch = e.target.value;
                            setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, targetBranch: branch } as PrStrategy
                            }));
                          }}
                          className="h-6 w-24 px-2 text-xs outline-none"
                          style={dlgInputStyle}
                        />
                      </label>
                      {(draft.prStrategy.kind === "per-lane" || draft.prStrategy.kind === "queue" || (draft.prStrategy.kind === "integration" && draft.prStrategy.prDepth === "open-and-comment")) && (
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={"draft" in draft.prStrategy ? draft.prStrategy.draft ?? true : true}
                            onChange={(e) => {
                              const isDraft = e.target.checked;
                              setDraft((p) => ({
                                ...p,
                                prStrategy: { ...p.prStrategy, draft: isDraft } as PrStrategy
                              }));
                            }}
                          />
                          Draft PR
                        </label>
                      )}
                    </div>
                  )}
                  {draft.prStrategy.kind === "queue" && (
                    <div className="mt-1 space-y-2">
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={draft.prStrategy.autoRebase ?? true}
                            onChange={(e) => setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, autoRebase: e.target.checked } as PrStrategy
                            }))}
                          />
                          Auto-rebase
                        </label>
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={draft.prStrategy.ciGating ?? true}
                            onChange={(e) => setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, ciGating: e.target.checked } as PrStrategy
                            }))}
                          />
                          CI gating
                        </label>
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={draft.prStrategy.rehearseQueue ?? false}
                            onChange={(e) => setDraft((p) => {
                              const prevQueue = p.prStrategy.kind === "queue" ? p.prStrategy : { kind: "queue" as const };
                              return {
                                ...p,
                                prStrategy: {
                                  ...prevQueue,
                                  rehearseQueue: e.target.checked,
                                  autoLand: e.target.checked ? false : prevQueue.autoLand,
                                } as PrStrategy
                              };
                            })}
                          />
                          Dry-run full queue
                        </label>
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={draft.prStrategy.autoLand ?? false}
                            onChange={(e) => setDraft((p) => {
                              const prevQueue = p.prStrategy.kind === "queue" ? p.prStrategy : { kind: "queue" as const };
                              return {
                                ...p,
                                prStrategy: {
                                  ...prevQueue,
                                  autoLand: e.target.checked,
                                  rehearseQueue: e.target.checked ? false : prevQueue.rehearseQueue,
                                } as PrStrategy
                              };
                            })}
                          />
                          Auto-land queue
                        </label>
                      </div>
                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={draft.prStrategy.autoResolveConflicts ?? false}
                            onChange={(e) => setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, autoResolveConflicts: e.target.checked } as PrStrategy
                            }))}
                          />
                          Auto-resolve conflicts
                        </label>
                        <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <input
                            type="checkbox"
                            checked={draft.prStrategy.archiveLaneOnLand ?? false}
                            onChange={(e) => setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, archiveLaneOnLand: e.target.checked } as PrStrategy
                            }))}
                          />
                          Archive lane on land
                        </label>
                        <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <span>Merge method</span>
                          <select
                            value={draft.prStrategy.mergeMethod ?? "squash"}
                            onChange={(e) => setDraft((p) => ({
                              ...p,
                              prStrategy: { ...p.prStrategy, mergeMethod: e.target.value as MergeMethod } as PrStrategy
                            }))}
                            className="h-6 px-2 text-xs outline-none"
                            style={dlgInputStyle}
                          >
                            <option value="merge">merge</option>
                            <option value="squash">squash</option>
                            <option value="rebase">rebase</option>
                          </select>
                        </label>
                      </div>
                      {(draft.prStrategy.autoResolveConflicts ?? false) ? (
                        <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          Uses the configured Claude/Codex CLI resolver model from mission runtime settings. Queue rehearsal runs on an isolated scratch lane and never merges; auto-land still merges for real. Launch is blocked if no compatible resolver model is available.
                        </div>
                      ) : null}
                    </div>
                  )}
                  {draft.prStrategy.kind === "integration" && (
                    <div className="mt-2 space-y-1">
                      <span style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted }}>
                        PR DEPTH
                      </span>
                      <div className="flex flex-col gap-0.5">
                        {([
                          { value: "propose-only" as PrDepth, label: "PROPOSE ONLY", desc: "Create draft PRs, flag conflicts" },
                          { value: "resolve-conflicts" as PrDepth, label: "RESOLVE CONFLICTS", desc: "Also resolve conflicts with AI workers" },
                          { value: "open-and-comment" as PrDepth, label: "OPEN & COMMENT", desc: "Also open PRs and add review comments" },
                        ] as const).map((opt) => {
                          const currentDepth = draft.prStrategy.kind === "integration" ? (draft.prStrategy.prDepth ?? "resolve-conflicts") : "resolve-conflicts";
                          const isSelected = currentDepth === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => {
                                setDraft((p) => ({
                                  ...p,
                                  prStrategy: { ...p.prStrategy, prDepth: opt.value } as PrStrategy
                                }));
                              }}
                              className="flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
                              style={{
                                background: isSelected ? `${COLORS.accent}18` : "transparent",
                                border: isSelected ? `1px solid ${COLORS.accent}30` : `1px solid ${COLORS.border}`,
                                fontFamily: MONO_FONT,
                              }}
                            >
                              <span
                                className="font-bold uppercase tracking-[1px]"
                                style={{ fontSize: 10, color: isSelected ? COLORS.accent : COLORS.textPrimary, minWidth: 130 }}
                              >
                                {opt.label}
                              </span>
                              <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                                {opt.desc}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 9, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 4 }}>
                        Closing automation never auto-merges without explicit human approval.
                      </div>
                    </div>
                  )}
                </div>

                {/* d. Phase Configuration */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span style={dlgLabelStyle}>
                      <Hash size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
                      PHASE CONFIGURATION
                    </span>
                    <select
                      value={draft.phaseProfileId ?? ""}
                      onChange={(e) => {
                        const nextProfileId = e.target.value || null;
                        const profile = phaseProfiles.find((entry) => entry.id === nextProfileId) ?? null;
                        setDraft((prev) => ({
                          ...prev,
                          phaseProfileId: nextProfileId,
                          phaseOverride: profile
                            ? profile.phases.map((phase, index) => ({ ...phase, position: index }))
                            : prev.phaseOverride
                        }));
                      }}
                      className="h-7 w-[220px] px-2 text-[10px] outline-none"
                      style={dlgInputStyle}
                      disabled={phaseLoading || phaseProfiles.length === 0}
                    >
                      <option value="">Select profile</option>
                      {phaseProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.isBuiltIn ? "\u25CF " : ""}{profile.name}{profile.description ? ` — ${profile.description}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      style={outlineButton()}
                      onClick={() => {
                        const now = new Date().toISOString();
                        setDraft((prev) => ({
                          ...prev,
                          phaseProfileId: prev.phaseProfileId,
                          phaseOverride: [
                            ...prev.phaseOverride,
                            {
                              id: `custom:${Date.now()}`,
                              phaseKey: `custom_${prev.phaseOverride.length + 1}`,
                              name: `Custom Phase ${prev.phaseOverride.length + 1}`,
                              description: "",
                              instructions: "",
                              model: { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
                              budget: {},
                              orderingConstraints: {},
                              askQuestions: { enabled: false, mode: "never" },
                              validationGate: { tier: "none", required: false },
                              isBuiltIn: false,
                              isCustom: true,
                              position: prev.phaseOverride.length,
                              createdAt: now,
                              updatedAt: now
                            }
                          ]
                        }));
                      }}
                    >
                      <Plus size={12} weight="bold" />
                      ADD CUSTOM PHASE
                    </button>
                    <select
                      value={selectedPhaseItemKey}
                      onChange={(e) => setSelectedPhaseItemKey(e.target.value)}
                      className="h-7 min-w-[220px] px-2 text-[10px] outline-none"
                      style={dlgInputStyle}
                      disabled={phaseItemsLoading || customPhaseItems.length === 0}
                      title="Pick a saved phase item to add to this mission."
                    >
                      <option value="">Add saved phase item...</option>
                      {customPhaseItems.map((item) => (
                        <option key={item.phaseKey} value={item.phaseKey}>
                          {item.name} ({item.phaseKey})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      style={outlineButton()}
                      disabled={!selectedPhaseItemKey}
                      onClick={() => {
                        const item = customPhaseItems.find((entry) => entry.phaseKey === selectedPhaseItemKey);
                        if (!item) return;
                        appendPhaseFromItem(item);
                        setPhaseNotice(`Added phase item "${item.name}".`);
                        setSelectedPhaseItemKey("");
                      }}
                    >
                      ADD ITEM
                    </button>
                    <button
                      type="button"
                      style={outlineButton()}
                      disabled={draft.phaseOverride.length === 0}
                      onClick={async () => {
                        const profileName = window.prompt("New phase profile name", "Custom Profile");
                        if (!profileName || !profileName.trim()) return;
                        try {
                          const saved = await window.ade.missions.savePhaseProfile({
                            profile: {
                              name: profileName.trim(),
                              description: "Saved from mission launch flow",
                              phases: draft.phaseOverride
                            }
                          });
                          setPhaseProfiles((prev) => {
                            const next = [saved, ...prev.filter((entry) => entry.id !== saved.id)];
                            setCachedPhaseProfiles(next);
                            return next;
                          });
                          setDraft((prev) => ({ ...prev, phaseProfileId: saved.id }));
                        } catch (err) {
                          setPhaseError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      SAVE AS PROFILE
                    </button>
                    <button
                      type="button"
                      style={outlineButton()}
                      disabled={phaseItemsLoading}
                      onClick={async () => {
                        const filePath = window.prompt("Path to phase items JSON", "");
                        if (!filePath || !filePath.trim()) return;
                        try {
                          const imported = await window.ade.missions.importPhaseItems({ filePath: filePath.trim() });
                          setPhaseItems((prev) => {
                            const map = new Map(prev.map((item) => [item.phaseKey, item] as const));
                            for (const item of imported) map.set(item.phaseKey, item);
                            const next = Array.from(map.values());
                            setCachedPhaseItems(next);
                            return next;
                          });
                          setPhaseNotice(`Imported ${imported.length} phase item${imported.length === 1 ? "" : "s"}.`);
                          setPhaseItemsError(null);
                        } catch (err) {
                          setPhaseItemsError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      IMPORT ITEMS
                    </button>
                    <button
                      type="button"
                      style={outlineButton()}
                      disabled={phaseItemsLoading}
                      onClick={async () => {
                        try {
                          const exported = await window.ade.missions.exportPhaseItems({});
                          setPhaseNotice(
                            exported.savedPath
                              ? `Exported ${exported.items.length} phase items to ${exported.savedPath}.`
                              : `Exported ${exported.items.length} phase items.`
                          );
                          setPhaseItemsError(null);
                        } catch (err) {
                          setPhaseItemsError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      EXPORT ITEMS
                    </button>
                    <button
                      type="button"
                      style={outlineButton()}
                      disabled={draft.phaseOverride.length === 0}
                      onClick={async () => {
                        const reusable = draft.phaseOverride.filter((phase) => !phase.isBuiltIn);
                        if (reusable.length === 0) {
                          setPhaseNotice("No custom phases to save as reusable items.");
                          return;
                        }
                        try {
                          const saved: PhaseCard[] = [];
                          for (const item of reusable) {
                            // Save each non-built-in phase card as a reusable phase item.
                            const next = await window.ade.missions.savePhaseItem({ item: { ...item, isBuiltIn: false, isCustom: true } });
                            saved.push(next);
                          }
                          setPhaseItems((prev) => {
                            const map = new Map(prev.map((item) => [item.phaseKey, item] as const));
                            for (const item of saved) map.set(item.phaseKey, item);
                            const next = Array.from(map.values());
                            setCachedPhaseItems(next);
                            return next;
                          });
                          setPhaseNotice(`Saved ${saved.length} reusable phase item${saved.length === 1 ? "" : "s"}.`);
                          setPhaseItemsError(null);
                        } catch (err) {
                          setPhaseItemsError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      SAVE CUSTOM ITEMS
                    </button>
                  </div>
                  {phaseLoading ? (
                    <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Loading phase profiles...
                    </div>
                  ) : null}
                  {phaseItemsLoading ? (
                    <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Loading phase items...
                    </div>
                  ) : null}
                  {phaseError ? (
                    <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger }}>
                      {phaseError}
                    </div>
                  ) : null}
                  {phaseItemsError ? (
                    <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger }}>
                      {phaseItemsError}
                    </div>
                  ) : null}
                  {phaseNotice ? (
                    <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.success}14`, border: `1px solid ${COLORS.success}30`, color: COLORS.success }}>
                      {phaseNotice}
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    {draft.phaseOverride.map((phase, index) => (
                      <PhaseCardEditor
                        key={phase.id}
                        phase={phase}
                        index={index}
                        totalCount={draft.phaseOverride.length}
                        expanded={expandedPhases[phase.id] === true}
                        readOnly={false}
                        showToggle
                        disabled={disabledPhases[phase.id] === true}
                        onToggleDisabled={() => setDisabledPhases((prev) => ({ ...prev, [phase.id]: !prev[phase.id] }))}
                        onToggleExpand={() => setExpandedPhases((prev) => ({ ...prev, [phase.id]: !prev[phase.id] }))}
                        onUpdate={(updated) => {
                          setDraft((prev) => ({
                            ...prev,
                            phaseOverride: prev.phaseOverride.map((entry) =>
                              entry.id === updated.id ? updated : entry
                            ),
                          }));
                        }}
                        onMoveUp={() => {
                          if (index === 0) return;
                          setDraft((prev) => {
                            const next = [...prev.phaseOverride];
                            const moved = next[index];
                            if (!moved) return prev;
                            next.splice(index, 1);
                            next.splice(index - 1, 0, moved);
                            return { ...prev, phaseOverride: next.map((entry, pos) => ({ ...entry, position: pos })) };
                          });
                        }}
                        onMoveDown={() => {
                          setDraft((prev) => {
                            if (index >= prev.phaseOverride.length - 1) return prev;
                            const next = [...prev.phaseOverride];
                            const moved = next[index];
                            if (!moved) return prev;
                            next.splice(index, 1);
                            next.splice(index + 1, 0, moved);
                            return { ...prev, phaseOverride: next.map((entry, pos) => ({ ...entry, position: pos })) };
                          });
                        }}
                        onRemove={phase.isCustom ? () => {
                          setDraft((prev) => ({
                            ...prev,
                            phaseOverride: prev.phaseOverride
                              .filter((entry) => entry.id !== phase.id)
                              .map((entry, pos) => ({ ...entry, position: pos })),
                          }));
                          setExpandedPhases((prev) => { const n = { ...prev }; delete n[phase.id]; return n; });
                          setDisabledPhases((prev) => { const n = { ...prev }; delete n[phase.id]; return n; });
                        } : undefined}
                        availableModelIds={availableModelIds}
                        labelStyle={dlgLabelStyle}
                        inputStyle={dlgInputStyle}
                        planningPromptPreview={{
                          missionPrompt: draft.prompt,
                          phases: draft.phaseOverride,
                        }}
                      />
                    ))}
                  </div>
                  {phaseValidationErrors.length > 0 ? (
                    <div className="space-y-1 px-2 py-1.5" style={{ background: `${COLORS.warning}15`, border: `1px solid ${COLORS.warning}30`, color: COLORS.warning }}>
                      {phaseValidationErrors.map((entry) => (
                        <div key={entry} className="text-[10px]" style={{ fontFamily: MONO_FONT }}>
                          {entry}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                {/* e. Smart Token Budget */}
                <SmartBudgetPanel
                  value={draft.modelConfig.smartBudget ?? { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 }}
                  onChange={(config) => setDraft((p) => ({
                    ...p,
                    modelConfig: { ...p.modelConfig, smartBudget: config }
                  }))}
                  currentSpend={selectedBudgetFamilies.hasApiModels && currentUsage ? {
                    fiveHourUsd: currentUsage.summary.totalCostEstimateUsd,
                    weeklyUsd: weeklyUsage?.summary.totalCostEstimateUsd ?? currentUsage.summary.totalCostEstimateUsd,
                  } : null}
                  modelUsage={selectedBudgetFamilies.hasApiModels && currentUsage?.byModel?.length ? Object.fromEntries(
                    currentUsage.byModel.map((m) => [m.model, {
                      inputTokens: m.inputTokens,
                      outputTokens: m.outputTokens,
                      costUsd: m.costEstimateUsd,
                      sessions: m.sessions,
                    }])
                  ) : undefined}
                  billingContext={billingContext}
                  perProvider={launcherPerProviderUsage}
                />

                <div className="space-y-1.5">
                  <span style={dlgLabelStyle}>AGENT RUNTIME CAPABILITIES</span>
                  <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <input
                      type="checkbox"
                      checked={draft.agentRuntime.allowParallelAgents}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setDraft((p) => ({
                          ...p,
                          agentRuntime: { ...p.agentRuntime, allowParallelAgents: checked },
                          ...(p.teamRuntime
                            ? { teamRuntime: { ...p.teamRuntime, allowParallelAgents: checked } }
                            : {})
                        }));
                      }}
                    />
                    ALLOW PARALLEL AGENTS / WORKERS
                  </label>
                  <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <input
                      type="checkbox"
                      checked={draft.agentRuntime.allowSubAgents}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setDraft((p) => ({
                          ...p,
                          agentRuntime: { ...p.agentRuntime, allowSubAgents: checked },
                          ...(p.teamRuntime
                            ? { teamRuntime: { ...p.teamRuntime, allowSubAgents: checked } }
                            : {})
                        }));
                      }}
                    />
                    ALLOW SUB-AGENTS (NESTED DELEGATION)
                  </label>
                  <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <input
                      type="checkbox"
                      checked={draft.agentRuntime.allowClaudeAgentTeams}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setDraft((p) => ({
                          ...p,
                          agentRuntime: { ...p.agentRuntime, allowClaudeAgentTeams: checked },
                          ...(p.teamRuntime
                            ? { teamRuntime: { ...p.teamRuntime, allowClaudeAgentTeams: checked } }
                            : {})
                        }));
                      }}
                    />
                    ALLOW CLAUDE CODE AGENT TEAMS
                  </label>
                  <div style={{ fontSize: 9, color: COLORS.textDim, fontFamily: MONO_FONT, marginTop: 2 }}>
                    These controls are passed to orchestrator strategy prompts and runtime metadata.
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <input
                      type="checkbox"
                      checked={draft.teamRuntime?.enabled ?? false}
                      title="Enable teammate worker orchestration for this mission."
                      onChange={(e) => setDraft((p) => ({
                        ...p,
                        teamRuntime: {
                          enabled: e.target.checked,
                          targetProvider: p.teamRuntime?.targetProvider ?? "auto",
                          teammateCount: p.teamRuntime?.teammateCount ?? 2,
                          allowParallelAgents: p.agentRuntime.allowParallelAgents,
                          allowSubAgents: p.agentRuntime.allowSubAgents,
                          allowClaudeAgentTeams: p.agentRuntime.allowClaudeAgentTeams,
                        }
                      }))}
                    />
                    ENABLE TEAM RUNTIME
                  </label>
                  <div className="pl-5 text-[9px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                    Team runtime lets the orchestrator coordinate additional teammate workers for parallel execution.
                  </div>
                  {draft.teamRuntime?.enabled && (
                    <div className="flex items-center gap-3 pl-5">
                      <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>TEAMMATES</span>
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={draft.teamRuntime?.teammateCount ?? 2}
                          title="Number of teammate workers available to the orchestrator."
                          onChange={(e) => setDraft((p) => ({
                            ...p,
                            teamRuntime: {
                              ...p.teamRuntime!,
                              teammateCount: Math.max(1, Math.min(8, Number(e.target.value) || 2)),
                            }
                          }))}
                          className="h-6 w-12 px-1 text-xs text-center outline-none"
                          style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 }}
                        />
                      </label>
                      <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>PROVIDER</span>
                        <select
                          value={draft.teamRuntime?.targetProvider ?? "auto"}
                          title="Preferred provider family for teammate workers."
                          onChange={(e) => setDraft((p) => ({
                            ...p,
                            teamRuntime: {
                              ...p.teamRuntime!,
                              targetProvider: e.target.value as "claude" | "codex" | "auto",
                            }
                          }))}
                          className="h-6 px-1 text-xs outline-none"
                          style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 }}
                        >
                          <option value="auto">Auto</option>
                          <option value="claude">Claude</option>
                          <option value="codex">Codex</option>
                        </select>
                      </label>
                    </div>
                  )}
                  {teamBudgetGuardrailActive ? (
                    <div
                      className="ml-5 flex items-center gap-1"
                      style={{ fontSize: 10, color: "#F59E0B", fontFamily: MONO_FONT }}
                    >
                      <Warning size={12} weight="bold" />
                      {`${teamBudgetGuardrailTeammateCount} teammates with Smart Budget disabled. Launch requires explicit confirmation.`}
                    </div>
                  ) : null}
                </div>

                {/* Worker Permissions — per-model-family (placed last so all model selections are finalized) */}
                <WorkerPermissionsSection
                  draft={draft}
                  activePhases={activePhases}
                  setDraft={setDraft}
                  dlgLabelStyle={dlgLabelStyle}
                  dlgInputStyle={dlgInputStyle}
                />
          </div>

        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          <button style={outlineButton()} onClick={onClose} disabled={busy}>CANCEL</button>
          <button
            style={primaryButton()}
            onClick={handleLaunch}
            disabled={busy || !draft.prompt.trim() || phaseValidationErrors.length > 0}
          >
            {busy ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            LAUNCH MISSION
          </button>
        </div>
      </motion.div>
    </div>
  );
}

export const CreateMissionDialog = React.memo(CreateMissionDialogInner);
