import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  Rocket,
  X,
  Plus,
  SpinnerGap,
  GitBranch,
  ChatCircle,
  Robot,
  Shield,
  CircleHalf,
  Hash,
  CaretLeft,
  CheckCircle,
  Warning,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type {
  MissionModelConfig,
  MissionPreflightChecklistItem,
  MissionPreflightResult,
  PhaseCard,
  PhaseProfile,
  PrStrategy,
  PrDepth,
  OrchestratorDecisionTimeoutCapHours,
  AggregatedUsageStats,
  TeamRuntimeConfig,
} from "../../../shared/types";
import { BUILT_IN_PROFILES } from "../../../shared/modelProfiles";
import { MODEL_REGISTRY } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton, outlineButton } from "../lanes/laneDesignTokens";
import { ModelSelector } from "./ModelSelector";
import { ModelProfileSelector } from "./ModelProfileSelector";
import { SmartBudgetPanel } from "./SmartBudgetPanel";
import { MissionPromptInput } from "./MissionPromptInput";

export type CreateDraft = {
  title: string;
  prompt: string;
  laneId: string;
  priority: import("../../../shared/types").MissionPriority;
  allowPlanningQuestions: boolean;
  allowCompletionWithRisk: boolean;
  prStrategy: PrStrategy;
  modelConfig: MissionModelConfig;
  phaseProfileId: string | null;
  phaseOverride: PhaseCard[];
  teamRuntime?: TeamRuntimeConfig;
};

const DECISION_TIMEOUT_CAP_OPTIONS: OrchestratorDecisionTimeoutCapHours[] = [6, 12, 24, 48];

const DEFAULT_MODEL_CONFIG: MissionModelConfig = {
  profileId: "standard",
  orchestratorModel: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
  decisionTimeoutCapHours: 24,
  intelligenceConfig: BUILT_IN_PROFILES[0].intelligenceConfig,
  smartBudget: { enabled: false, fiveHourThresholdUsd: 10, weeklyThresholdUsd: 50 },
};

function validatePhaseOrder(cards: PhaseCard[]): string[] {
  if (!cards.length) return ["At least one phase is required."];
  const errors: string[] = [];
  const byKey = new Map<string, number>();
  cards.forEach((card, index) => {
    if (!card.phaseKey.trim()) errors.push(`Phase ${index + 1} is missing a key.`);
    if (byKey.has(card.phaseKey)) errors.push(`Duplicate phase key: ${card.phaseKey}`);
    byKey.set(card.phaseKey, index);
    if (card.orderingConstraints.mustBeFirst && index !== 0) {
      errors.push(`${card.name} must be first.`);
    }
    if (card.orderingConstraints.mustBeLast && index !== cards.length - 1) {
      errors.push(`${card.name} must be last.`);
    }
  });
  cards.forEach((card, index) => {
    (card.orderingConstraints.mustFollow ?? []).forEach((dep) => {
      const depIndex = byKey.get(dep);
      if (depIndex == null) errors.push(`${card.name} requires missing predecessor ${dep}.`);
      if (depIndex != null && depIndex >= index) errors.push(`${card.name} must follow ${dep}.`);
    });
    (card.orderingConstraints.mustPrecede ?? []).forEach((dep) => {
      const depIndex = byKey.get(dep);
      if (depIndex == null) errors.push(`${card.name} requires missing successor ${dep}.`);
      if (depIndex != null && depIndex <= index) errors.push(`${card.name} must precede ${dep}.`);
    });
  });
  return [...new Set(errors)];
}

function preflightSeverityHex(severity: MissionPreflightChecklistItem["severity"]): string {
  if (severity === "pass") return "#22C55E";
  if (severity === "warning") return "#F59E0B";
  return "#EF4444";
}

function formatPreflightDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "n/a";
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
  }
  return `${mins}m`;
}

const DLG_INPUT_STYLE: React.CSSProperties = { background: COLORS.recessedBg, border: `1px solid ${COLORS.outlineBorder}`, color: COLORS.textPrimary, fontFamily: MONO_FONT, borderRadius: 0 };
const DLG_LABEL_STYLE: React.CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted };

function CreateMissionDialogInner({
  open,
  onClose,
  onLaunch,
  busy,
  lanes,
}: {
  open: boolean;
  onClose: () => void;
  onLaunch: (draft: CreateDraft) => void;
  busy: boolean;
  lanes: Array<{ id: string; name: string }>;
}) {
  const sortedLanes = useMemo(
    () => [...lanes].sort((a, b) => a.name.localeCompare(b.name)),
    [lanes]
  );
  const [selectedProfileId, setSelectedProfileId] = useState<string>("standard");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [phaseProfiles, setPhaseProfiles] = useState<PhaseProfile[]>([]);
  const [phaseLoading, setPhaseLoading] = useState(false);
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [expandedPhases, setExpandedPhases] = useState<Record<string, boolean>>({});
  const [disabledPhases, setDisabledPhases] = useState<Record<string, boolean>>({});
  const [availableModelIds, setAvailableModelIds] = useState<string[] | undefined>(undefined);
  const [aiDetectedAuth, setAiDetectedAuth] = useState<import("../../../shared/types").AiDetectedAuth[] | null>(null);
  const [currentUsage, setCurrentUsage] = useState<AggregatedUsageStats | null>(null);
  const [weeklyUsage, setWeeklyUsage] = useState<AggregatedUsageStats | null>(null);
  const [launchStage, setLaunchStage] = useState<"config" | "preflight">("config");
  const [preflightRunning, setPreflightRunning] = useState(false);
  const [preflightResult, setPreflightResult] = useState<MissionPreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateDraft>({
    title: "",
    prompt: "",
    laneId: "",
    priority: "normal",
    allowPlanningQuestions: true,
    allowCompletionWithRisk: true,
    prStrategy: { kind: "integration", targetBranch: "main", draft: true },
    modelConfig: { ...DEFAULT_MODEL_CONFIG },
    phaseProfileId: null,
    phaseOverride: [],
  });

  useEffect(() => {
    if (!open) return;
    setSelectedProfileId("standard");
    setAttachments([]);
    setPhaseError(null);
    setExpandedPhases({});
    setDisabledPhases({});
    setLaunchStage("config");
    setPreflightRunning(false);
    setPreflightResult(null);
    setPreflightError(null);
    setDraft({
      title: "",
      prompt: "",
      laneId: "",
      priority: "normal",
      allowPlanningQuestions: true,
      allowCompletionWithRisk: true,
      prStrategy: { kind: "integration", targetBranch: "main", draft: true },
      modelConfig: { ...DEFAULT_MODEL_CONFIG },
      phaseProfileId: null,
      phaseOverride: [],
    });

    let cancelled = false;
    setPhaseLoading(true);
    void window.ade.missions
      .listPhaseProfiles({})
      .then((profiles) => {
        if (cancelled) return;
        setPhaseProfiles(profiles);
        const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
        if (!defaultProfile) {
          setDraft((prev) => ({ ...prev, phaseProfileId: null, phaseOverride: [] }));
          return;
        }
        setDraft((prev) => ({
          ...prev,
          phaseProfileId: defaultProfile.id,
          phaseOverride: defaultProfile.phases.map((phase, index) => ({ ...phase, position: index }))
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setPhaseProfiles([]);
        setPhaseError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setPhaseLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      void window.ade.ai.getStatus().then((status) => {
        if (cancelled) return;
        const ids: string[] = [];
        const auth = status.detectedAuth ?? [];
        setAiDetectedAuth(auth);
        for (const a of auth) {
          if (!a.authenticated) continue;
          if (a.type === "cli-subscription" && a.cli) {
            const familyMap: Record<string, string> = { claude: "anthropic", codex: "openai", gemini: "google" };
            const family = familyMap[a.cli];
            if (family) {
              for (const m of MODEL_REGISTRY) {
                if (m.family === family && !m.deprecated) ids.push(m.id);
              }
            }
          }
          if (a.type === "api-key" && a.provider) {
            for (const m of MODEL_REGISTRY) {
              if (m.family === a.provider && !m.deprecated) ids.push(m.id);
            }
          }
        }
        setAvailableModelIds(ids.length > 0 ? [...new Set(ids)] : undefined);
      }).catch(() => {
        if (!cancelled) setAvailableModelIds(undefined);
      });

      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      void window.ade.orchestrator.getAggregatedUsage({ since: fiveHoursAgo }).then((stats) => {
        if (!cancelled) setCurrentUsage(stats);
      }).catch(() => {
        if (!cancelled) setCurrentUsage(null);
      });

      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      void window.ade.orchestrator.getAggregatedUsage({ since: oneWeekAgo }).then((stats) => {
        if (!cancelled) setWeeklyUsage(stats);
      }).catch(() => {
        if (!cancelled) setWeeklyUsage(null);
      });
    });

    return () => { cancelled = true; cancelAnimationFrame(rafId); };
  }, [open]);

  // Reset preflight when the user edits the draft (but NOT when launchStage
  // itself transitions to "preflight" — that would immediately clear results).
  const launchStageRef = React.useRef(launchStage);
  launchStageRef.current = launchStage;
  useEffect(() => {
    if (!open) return;
    if (launchStageRef.current !== "preflight") return;
    setLaunchStage("config");
    setPreflightResult(null);
    setPreflightError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, open]);

  const activePhases = useMemo(() => {
    return draft.phaseOverride
      .filter((phase) => !disabledPhases[phase.id])
      .map((phase, index) => ({ ...phase, position: index }));
  }, [draft.phaseOverride, disabledPhases]);

  const phaseValidationErrors = useMemo(() => validatePhaseOrder(activePhases), [activePhases]);

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

  const handleLaunch = useCallback(() => {
    if (!draft.prompt.trim()) return;
    if (validatePhaseOrder(activePhases).length > 0) return;
    if (launchStage === "preflight") {
      if (!preflightResult?.canLaunch) return;
      onLaunch({ ...draft, phaseOverride: activePhases });
      return;
    }
    setPreflightError(null);
    setPreflightRunning(true);
    void window.ade.missions.preflight({
      launch: {
        title: draft.title.trim() || undefined,
        prompt: draft.prompt.trim(),
        laneId: draft.laneId.trim() || undefined,
        priority: draft.priority,
        allowPlanningQuestions: draft.allowPlanningQuestions,
        allowCompletionWithRisk: draft.allowCompletionWithRisk,
        teamRuntime: draft.teamRuntime,
        modelConfig: {
          ...draft.modelConfig,
          decisionTimeoutCapHours: draft.modelConfig.decisionTimeoutCapHours ?? 24,
        },
        phaseProfileId: draft.phaseProfileId,
        phaseOverride: activePhases,
      }
    })
      .then((result) => {
        setPreflightResult(result);
        setLaunchStage("preflight");
      })
      .catch((err) => {
        setPreflightError(err instanceof Error ? err.message : String(err));
        setPreflightResult(null);
      })
      .finally(() => {
        setPreflightRunning(false);
      });
  }, [draft, activePhases, launchStage, onLaunch, preflightResult?.canLaunch]);

  if (!open) return null;

  const dlgInputStyle = DLG_INPUT_STYLE;
  const dlgLabelStyle = DLG_LABEL_STYLE;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.15 } }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-3xl shadow-2xl max-h-[90vh] overflow-y-auto"
        style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
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

          {/* 4. Profile */}
          <div className="space-y-1">
            <span style={dlgLabelStyle}>
              <CircleHalf size={12} weight="bold" className="inline mr-1 -mt-0.5" style={{ color: COLORS.textMuted }} />
              PROFILE
            </span>
            <ModelProfileSelector
              selectedProfileId={selectedProfileId}
              onSelect={(profile) => {
                if (profile) {
                  setSelectedProfileId(profile.id);
                  setDraft((p) => ({
                    ...p,
                    modelConfig: {
                      profileId: profile.id,
                      orchestratorModel: profile.orchestratorModel,
                      decisionTimeoutCapHours: profile.decisionTimeoutCapHours ?? 24,
                      intelligenceConfig: profile.intelligenceConfig,
                      smartBudget: profile.smartBudget ?? p.modelConfig.smartBudget,
                    },
                  }));
                } else {
                  setSelectedProfileId("custom");
                }
              }}
            />
          </div>

          {/* 5. Orchestrator Model */}
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
                    setSelectedProfileId("custom");
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

          {/* 6. Additional Options */}
          <div className="space-y-3">
                {/* Decision Timeout Cap */}
                <label className="block space-y-1">
                  <span style={dlgLabelStyle}>DECISION TIMEOUT CAP</span>
                  <select
                    value={draft.modelConfig.decisionTimeoutCapHours ?? 24}
                    onChange={(e) => {
                      setSelectedProfileId("custom");
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
                        integration: "INTEGRATION PR",
                        "per-lane": "PER-LANE PRS",
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
                    <div className="flex items-center gap-3 mt-1">
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
                        Orchestrator never merges — always requires human approval
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
                  <div className="flex items-center gap-2">
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
                              model: { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" },
                              budget: {},
                              orderingConstraints: {},
                              askQuestions: { enabled: false, mode: "never" },
                              validationGate: { tier: "self", required: false },
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
                          setPhaseProfiles((prev) => [saved, ...prev.filter((entry) => entry.id !== saved.id)]);
                          setDraft((prev) => ({ ...prev, phaseProfileId: saved.id }));
                        } catch (err) {
                          setPhaseError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      SAVE AS PROFILE
                    </button>
                  </div>
                  {phaseLoading ? (
                    <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Loading phase profiles...
                    </div>
                  ) : null}
                  {phaseError ? (
                    <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger }}>
                      {phaseError}
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    {draft.phaseOverride.map((phase, index) => {
                      const expanded = expandedPhases[phase.id] === true;
                      const isDisabled = disabledPhases[phase.id] === true;
                      return (
                        <div
                          key={phase.id}
                          className="p-2"
                          style={{
                            background: isDisabled ? `${COLORS.recessedBg}80` : COLORS.recessedBg,
                            border: `1px solid ${isDisabled ? COLORS.border + "60" : COLORS.border}`,
                            opacity: isDisabled ? 0.5 : 1,
                            transition: "opacity 0.15s ease",
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setDisabledPhases((prev) => ({ ...prev, [phase.id]: !isDisabled }))}
                              title={isDisabled ? "Enable phase" : "Disable phase"}
                              style={{
                                width: 28,
                                height: 14,
                                background: isDisabled ? COLORS.border : "#22C55E",
                                border: "none",
                                borderRadius: 0,
                                cursor: "pointer",
                                position: "relative",
                                flexShrink: 0,
                                transition: "background 0.2s ease",
                              }}
                            >
                              <div
                                style={{
                                  position: "absolute",
                                  top: 2,
                                  left: isDisabled ? 2 : 14,
                                  width: 10,
                                  height: 10,
                                  background: isDisabled ? COLORS.textDim : COLORS.textPrimary,
                                  borderRadius: 0,
                                  transition: "left 0.2s ease",
                                }}
                              />
                            </button>
                            <span className="text-[10px] font-bold" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                              {index + 1}.
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[11px] font-semibold" style={{ color: isDisabled ? COLORS.textDim : COLORS.textPrimary }}>
                                {phase.name}
                                {phase.isCustom ? (
                                  <span style={{ fontSize: 9, fontWeight: 600, color: "#F59E0B", marginLeft: 4, fontFamily: MONO_FONT }}>CUSTOM</span>
                                ) : null}
                                {isDisabled ? <span style={{ color: COLORS.textDim, fontWeight: 400 }}> (disabled)</span> : null}
                              </div>
                              {phase.description ? (
                                <div className="truncate text-[10px]" style={{ color: COLORS.textDim }}>
                                  {phase.description}
                                </div>
                              ) : null}
                              <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                {phase.model.modelId} · {phase.validationGate.tier}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="px-1 text-[10px]"
                              style={{ color: COLORS.textMuted }}
                              disabled={index === 0}
                              onClick={() => {
                                if (index === 0) return;
                                setDraft((prev) => {
                                  const next = [...prev.phaseOverride];
                                  const moved = next[index];
                                  if (!moved) return prev;
                                  next.splice(index, 1);
                                  next.splice(index - 1, 0, moved);
                                  return {
                                    ...prev,
                                    phaseOverride: next.map((entry, pos) => ({ ...entry, position: pos }))
                                  };
                                });
                              }}
                              title="Move up"
                            >
                              {"\u2191"}
                            </button>
                            <button
                              type="button"
                              className="px-1 text-[10px]"
                              style={{ color: COLORS.textMuted }}
                              disabled={index === draft.phaseOverride.length - 1}
                              onClick={() => {
                                if (index >= draft.phaseOverride.length - 1) return;
                                setDraft((prev) => {
                                  const next = [...prev.phaseOverride];
                                  const moved = next[index];
                                  if (!moved) return prev;
                                  next.splice(index, 1);
                                  next.splice(index + 1, 0, moved);
                                  return {
                                    ...prev,
                                    phaseOverride: next.map((entry, pos) => ({ ...entry, position: pos }))
                                  };
                                });
                              }}
                              title="Move down"
                            >
                              {"\u2193"}
                            </button>
                            <button
                              type="button"
                              className="px-2 text-[10px] font-bold uppercase tracking-[1px]"
                              style={outlineButton()}
                              onClick={() => setExpandedPhases((prev) => ({ ...prev, [phase.id]: !expanded }))}
                              disabled={isDisabled}
                            >
                              {expanded ? "HIDE" : "CONFIGURE"}
                            </button>
                            {phase.isCustom ? (
                              <button
                                type="button"
                                className="px-1"
                                style={{ color: COLORS.danger, background: "none", border: "none", cursor: "pointer" }}
                                onClick={() => {
                                  setDraft((prev) => ({
                                    ...prev,
                                    phaseOverride: prev.phaseOverride
                                      .filter((entry) => entry.id !== phase.id)
                                      .map((entry, pos) => ({ ...entry, position: pos }))
                                  }));
                                  setExpandedPhases((prev) => { const n = { ...prev }; delete n[phase.id]; return n; });
                                  setDisabledPhases((prev) => { const n = { ...prev }; delete n[phase.id]; return n; });
                                }}
                                title="Remove custom phase"
                              >
                                <X size={12} weight="bold" />
                              </button>
                            ) : null}
                          </div>
                          {expanded && !isDisabled ? (
                            <div className="mt-2 space-y-2">
                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                <label className="space-y-1 text-[10px]">
                                  <span style={dlgLabelStyle}>PHASE NAME</span>
                                  <input
                                    value={phase.name}
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      setDraft((prev) => ({
                                        ...prev,
                                        phaseOverride: prev.phaseOverride.map((entry) =>
                                          entry.id === phase.id ? { ...entry, name: value } : entry
                                        )
                                      }));
                                    }}
                                    className="h-7 w-full px-2 outline-none"
                                    style={dlgInputStyle}
                                  />
                                </label>
                                <div className="space-y-1 text-[10px]">
                                  <span style={dlgLabelStyle}>WORKER MODEL</span>
                                  <ModelSelector
                                    value={phase.model}
                                    onChange={(config) => {
                                      setDraft((prev) => ({
                                        ...prev,
                                        phaseOverride: prev.phaseOverride.map((entry) =>
                                          entry.id === phase.id ? { ...entry, model: config } : entry
                                        )
                                      }));
                                    }}
                                    compact
                                    availableModelIds={availableModelIds}
                                  />
                                </div>
                              </div>
                              <label className="space-y-1 text-[10px]">
                                <span style={dlgLabelStyle}>DESCRIPTION</span>
                                <input
                                  value={phase.description}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setDraft((prev) => ({
                                      ...prev,
                                      phaseOverride: prev.phaseOverride.map((entry) =>
                                        entry.id === phase.id ? { ...entry, description: value } : entry
                                      )
                                    }));
                                  }}
                                  placeholder="Brief description of what this phase does"
                                  className="h-7 w-full px-2 outline-none"
                                  style={dlgInputStyle}
                                />
                              </label>
                              <label className="space-y-1 text-[10px]">
                                <span style={dlgLabelStyle}>INSTRUCTIONS</span>
                                <textarea
                                  value={phase.instructions}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setDraft((prev) => ({
                                      ...prev,
                                      phaseOverride: prev.phaseOverride.map((entry) =>
                                        entry.id === phase.id ? { ...entry, instructions: value } : entry
                                      )
                                    }));
                                  }}
                                  className="w-full px-2 py-1.5 outline-none"
                                  rows={3}
                                  style={dlgInputStyle}
                                />
                              </label>

                              <div className="space-y-1">
                                <span style={dlgLabelStyle}>VALIDATION GATE</span>
                                <div className="flex items-center gap-3">
                                  <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    <span style={{ fontSize: 9 }}>Tier</span>
                                    <select
                                      value={phase.validationGate.tier}
                                      onChange={(e) => {
                                        const tier = e.target.value as import("../../../shared/types").MissionPhaseValidationTier;
                                        setDraft((prev) => ({
                                          ...prev,
                                          phaseOverride: prev.phaseOverride.map((entry) =>
                                            entry.id === phase.id ? { ...entry, validationGate: { ...entry.validationGate, tier } } : entry
                                          )
                                        }));
                                      }}
                                      className="h-6 px-1 outline-none"
                                      style={{ ...dlgInputStyle, width: "auto", minWidth: 90 }}
                                    >
                                      <option value="none">None</option>
                                      <option value="self">Self</option>
                                      <option value="spot-check">Spot-check</option>
                                      <option value="dedicated">Dedicated</option>
                                    </select>
                                  </label>
                                  <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    <input
                                      type="checkbox"
                                      checked={phase.validationGate.required}
                                      onChange={(e) => {
                                        const required = e.target.checked;
                                        setDraft((prev) => ({
                                          ...prev,
                                          phaseOverride: prev.phaseOverride.map((entry) =>
                                            entry.id === phase.id ? { ...entry, validationGate: { ...entry.validationGate, required } } : entry
                                          )
                                        }));
                                      }}
                                    />
                                    Required
                                  </label>
                                </div>
                                {phase.validationGate.tier !== "none" && (
                                  <input
                                    value={phase.validationGate.criteria ?? ""}
                                    onChange={(e) => {
                                      const criteria = e.target.value || undefined;
                                      setDraft((prev) => ({
                                        ...prev,
                                        phaseOverride: prev.phaseOverride.map((entry) =>
                                          entry.id === phase.id ? { ...entry, validationGate: { ...entry.validationGate, criteria } } : entry
                                        )
                                      }));
                                    }}
                                    placeholder="Validation criteria (e.g. all tests pass, no lint errors)"
                                    className="h-6 w-full px-2 outline-none text-[10px]"
                                    style={dlgInputStyle}
                                  />
                                )}
                              </div>

                              <div className="space-y-1">
                                <span style={dlgLabelStyle}>CLARIFICATION</span>
                                <div className="flex flex-wrap items-center gap-3">
                                  <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    <input
                                      type="checkbox"
                                      checked={phase.askQuestions.enabled}
                                      onChange={(e) => {
                                        const enabled = e.target.checked;
                                        setDraft((prev) => ({
                                          ...prev,
                                          phaseOverride: prev.phaseOverride.map((entry) =>
                                            entry.id === phase.id
                                              ? {
                                                  ...entry,
                                                  askQuestions: {
                                                    ...entry.askQuestions,
                                                    enabled,
                                                    mode: enabled
                                                      ? (entry.askQuestions.mode === "never" ? "auto_if_uncertain" : entry.askQuestions.mode)
                                                      : "never"
                                                  }
                                                }
                                              : entry
                                          )
                                        }));
                                      }}
                                    />
                                    Enabled
                                  </label>
                                  <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    <span style={{ fontSize: 9 }}>Mode</span>
                                    <select
                                      value={phase.askQuestions.mode}
                                      onChange={(e) => {
                                        const mode = e.target.value as "always" | "auto_if_uncertain" | "never";
                                        setDraft((prev) => ({
                                          ...prev,
                                          phaseOverride: prev.phaseOverride.map((entry) =>
                                            entry.id === phase.id
                                              ? {
                                                  ...entry,
                                                  askQuestions: {
                                                    ...entry.askQuestions,
                                                    mode,
                                                    enabled: mode === "never" ? false : entry.askQuestions.enabled
                                                  }
                                                }
                                              : entry
                                          )
                                        }));
                                      }}
                                      className="h-6 px-1 outline-none"
                                      style={{ ...dlgInputStyle, width: "auto", minWidth: 130 }}
                                    >
                                      <option value="auto_if_uncertain">Auto (if uncertain)</option>
                                      <option value="always">Always</option>
                                      <option value="never">Never</option>
                                    </select>
                                  </label>
                                  <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    <span style={{ fontSize: 9 }}>Max questions</span>
                                    <input
                                      type="number"
                                      min={1}
                                      max={10}
                                      value={Math.max(1, Math.min(10, Number(phase.askQuestions.maxQuestions ?? 5) || 5))}
                                      onChange={(e) => {
                                        const maxQuestions = Math.max(1, Math.min(10, Number(e.target.value) || 5));
                                        setDraft((prev) => ({
                                          ...prev,
                                          phaseOverride: prev.phaseOverride.map((entry) =>
                                            entry.id === phase.id
                                              ? { ...entry, askQuestions: { ...entry.askQuestions, maxQuestions } }
                                              : entry
                                          )
                                        }));
                                      }}
                                      className="h-6 w-16 px-1 text-[10px] text-center outline-none"
                                      style={dlgInputStyle}
                                    />
                                  </label>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
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
                  currentSpend={currentUsage ? {
                    fiveHourUsd: currentUsage.summary.totalCostEstimateUsd,
                    weeklyUsd: weeklyUsage?.summary.totalCostEstimateUsd ?? currentUsage.summary.totalCostEstimateUsd,
                  } : null}
                  modelUsage={currentUsage?.byModel?.length ? Object.fromEntries(
                    currentUsage.byModel.map((m) => [m.model, {
                      inputTokens: m.inputTokens,
                      outputTokens: m.outputTokens,
                      costUsd: m.costEstimateUsd,
                      sessions: m.sessions,
                    }])
                  ) : undefined}
                  billingContext={billingContext}
                />

                <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  <input
                    type="checkbox"
                    checked={draft.allowPlanningQuestions}
                    onChange={(e) => setDraft((p) => ({ ...p, allowPlanningQuestions: e.target.checked }))}
                  />
                  ALLOW PLANNING CLARIFICATION QUESTIONS
                </label>

                <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  <input
                    type="checkbox"
                    checked={draft.allowCompletionWithRisk}
                    onChange={(e) => setDraft((p) => ({ ...p, allowCompletionWithRisk: e.target.checked }))}
                  />
                  ALLOW COMPLETION WITH RISK
                </label>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <input
                      type="checkbox"
                      checked={draft.teamRuntime?.enabled ?? false}
                      onChange={(e) => setDraft((p) => ({
                        ...p,
                        teamRuntime: {
                          enabled: e.target.checked,
                          targetProvider: p.teamRuntime?.targetProvider ?? "auto",
                          teammateCount: p.teamRuntime?.teammateCount ?? 2,
                        }
                      }))}
                    />
                    ENABLE TEAM RUNTIME
                  </label>
                  {draft.teamRuntime?.enabled && (
                    <div className="flex items-center gap-3 pl-5">
                      <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>TEAMMATES</span>
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={draft.teamRuntime?.teammateCount ?? 2}
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
                </div>
          </div>

          {(preflightRunning || preflightResult || preflightError) ? (
            <div className="space-y-2 p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <div className="flex items-center justify-between gap-2">
                <span style={dlgLabelStyle}>PRE-FLIGHT CHECKLIST</span>
                {preflightRunning ? (
                  <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    <SpinnerGap size={12} className="animate-spin" />
                    Checking...
                  </span>
                ) : null}
              </div>

              {preflightError ? (
                <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger }}>
                  {preflightError}
                </div>
              ) : null}

              {preflightResult ? (
                <div className="space-y-1.5">
                  {preflightResult.checklist.map((item) => {
                    const accent = preflightSeverityHex(item.severity);
                    return (
                      <div key={item.id} className="p-2" style={{ background: COLORS.cardBg, border: `1px solid ${accent}45` }}>
                        <div className="flex items-start gap-2">
                          {item.severity === "pass" ? (
                            <CheckCircle size={14} weight="fill" style={{ color: accent, marginTop: 1 }} />
                          ) : item.severity === "warning" ? (
                            <Warning size={14} weight="fill" style={{ color: accent, marginTop: 1 }} />
                          ) : (
                            <X size={14} weight="bold" style={{ color: accent, marginTop: 1 }} />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: accent, fontFamily: MONO_FONT }}>
                              {item.title}
                            </div>
                            <div className="mt-0.5 text-[11px]" style={{ color: COLORS.textPrimary }}>
                              {item.summary}
                            </div>
                            {item.details.length > 0 ? (
                              <ul className="mt-1 space-y-0.5 pl-4 text-[10px]">
                                {item.details.map((detail, idx) => (
                                  <li key={`${item.id}:${idx}`} style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                    • {detail}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {item.fixHint ? (
                              <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                                Fix: {item.fixHint}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {preflightResult.budgetEstimate ? (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-3 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>Mode: {preflightResult.budgetEstimate.mode}</span>
                        <span>Est. Cost: {preflightResult.budgetEstimate.estimatedCostUsd != null ? `$${preflightResult.budgetEstimate.estimatedCostUsd.toFixed(2)}` : "n/a"}</span>
                        <span>Est. Time: {formatPreflightDuration(preflightResult.budgetEstimate.estimatedTimeMs)}</span>
                        <span>Hard fails: {preflightResult.hardFailures}</span>
                        <span>Warnings: {preflightResult.warnings}</span>
                      </div>
                      {(() => {
                        const rows = preflightResult.budgetEstimate?.perPhase ?? [];
                        const totalCost = rows.reduce((sum, phase) => sum + (phase.estimatedCostUsd ?? 0), 0);
                        if (!rows.length || totalCost <= 0) return null;
                        return (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                              Phase Cost Allocation
                            </div>
                            <div className="flex h-2 w-full overflow-hidden rounded-sm" style={{ border: `1px solid ${COLORS.border}` }}>
                              {rows.map((phase, index) => {
                                const cost = Math.max(0, phase.estimatedCostUsd ?? 0);
                                const pct = Math.max(0, Math.min(100, (cost / totalCost) * 100));
                                const hue = (index * 63) % 360;
                                return (
                                  <div
                                    key={`phase-budget:${phase.phaseKey}`}
                                    title={`${phase.phaseName}: $${cost.toFixed(2)} (${pct.toFixed(1)}%)`}
                                    style={{ width: `${pct}%`, background: `hsl(${hue} 75% 52%)` }}
                                  />
                                );
                              })}
                            </div>
                            <div className="grid grid-cols-1 gap-0.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                              {rows.map((phase, index) => {
                                const cost = Math.max(0, phase.estimatedCostUsd ?? 0);
                                const pct = Math.max(0, Math.min(100, (cost / totalCost) * 100));
                                const hue = (index * 63) % 360;
                                return (
                                  <div key={`phase-budget-label:${phase.phaseKey}`} className="flex items-center justify-between gap-2">
                                    <span className="inline-flex items-center gap-1 min-w-0 truncate">
                                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: `hsl(${hue} 75% 52%)` }} />
                                      <span className="truncate">{phase.phaseName}</span>
                                    </span>
                                    <span>{`$${cost.toFixed(2)} (${pct.toFixed(0)}%)`}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
          {launchStage === "preflight" ? (
            <>
              <button
                style={outlineButton()}
                onClick={() => {
                  setLaunchStage("config");
                  setPreflightError(null);
                }}
                disabled={busy || preflightRunning}
              >
                <CaretLeft size={12} weight="bold" />
                BACK
              </button>
              <button
                style={outlineButton()}
                onClick={() => {
                  setLaunchStage("config");
                  setPreflightResult(null);
                  setPreflightError(null);
                }}
                disabled={busy || preflightRunning}
              >
                EDIT CONFIG
              </button>
              <button
                style={primaryButton()}
                onClick={handleLaunch}
                disabled={busy || preflightRunning || !preflightResult?.canLaunch}
              >
                {busy ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                LAUNCH MISSION
              </button>
            </>
          ) : (
            <>
              <button style={outlineButton()} onClick={onClose} disabled={busy || preflightRunning}>CANCEL</button>
              <button
                style={primaryButton()}
                onClick={handleLaunch}
                disabled={busy || preflightRunning || !draft.prompt.trim() || phaseValidationErrors.length > 0}
              >
                {preflightRunning ? <SpinnerGap className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
                RUN PRE-FLIGHT
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export const CreateMissionDialog = React.memo(CreateMissionDialogInner);
