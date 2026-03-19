import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle,
  FolderOpen,
  GitBranch,
  IdentificationCard,
} from "@phosphor-icons/react";
import { getModelById, resolveModelDescriptor } from "../../../shared/modelRegistry";
import type {
  CtoPersonalityPreset,
  LinearConnectionStatus,
  OnboardingDetectionResult,
} from "../../../shared/types";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { StepWizard } from "./shared/StepWizard";
import type { WizardStep } from "./shared/StepWizard";
import { cardCls, labelCls, recessedPanelCls, textareaCls } from "./shared/designTokens";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { LinearConnectionPanel } from "./LinearConnectionPanel";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { CTO_PERSONALITY_PRESETS, getCtoPersonalityPreset } from "./identityPresets";
import { CtoPromptPreview } from "./CtoPromptPreview";

const CTO_DISPLAY_NAME = "CTO";

const STEPS: WizardStep[] = [
  { id: "identity", label: "Identity", description: "Choose the brain and leadership style.", icon: IdentificationCard },
  { id: "project", label: "Project", description: "Write the long-term CTO brief.", icon: FolderOpen },
  { id: "integrations", label: "Linear", description: "Optionally connect issue routing.", icon: GitBranch },
];

type IdentityDraft = {
  customPersonality: string;
  personality: CtoPersonalityPreset;
  provider: string;
  model: string;
  modelId: string | null;
  reasoningEffort: string | null;
};

type ProjectDraft = {
  projectSummary: string;
  conventions: string;
  activeFocus: string;
};

function splitDraftList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function summarizeDraftList(value: string, fallback: string): string {
  const items = splitDraftList(value);
  return items.length ? items.join(" · ") : fallback;
}

function summarizeDetection(result: OnboardingDetectionResult | null): ProjectDraft | null {
  if (!result) return null;
  const projectTypes = result.projectTypes.filter(Boolean);
  const signals = result.indicators.slice(0, 4).map((indicator) => indicator.file);
  return {
    projectSummary: `This repo looks like a ${projectTypes.join(", ") || "software"} project. ADE detected signals from ${signals.join(", ") || "local repository files"}.`,
    conventions: projectTypes.length ? projectTypes.map((type) => `${type} conventions`).join(", ") : "",
    activeFocus: projectTypes.length ? `stabilize ${projectTypes[0]} workflows` : "capture the current priorities",
  };
}

function pickReasoningEffort(modelId: string | null | undefined, preferred: string | null | undefined): string | null {
  const tiers = modelId ? (getModelById(modelId)?.reasoningTiers ?? []) : [];
  if (!tiers.length) return preferred ?? null;
  if (preferred && tiers.includes(preferred)) return preferred;
  return tiers.includes("medium") ? "medium" : tiers[0] ?? null;
}

function applyModelSelection(draft: IdentityDraft, modelId: string): IdentityDraft {
  const descriptor = getModelById(modelId);
  if (!descriptor) return draft;
  return {
    ...draft,
    provider: descriptor.family,
    model: descriptor.shortId ?? descriptor.id.split("/").pop() ?? descriptor.id,
    modelId: descriptor.id,
    reasoningEffort: pickReasoningEffort(descriptor.id, draft.reasoningEffort),
  };
}

function coerceConfiguredModel(draft: IdentityDraft, configuredModelIds: string[]): IdentityDraft {
  if (configuredModelIds.length === 0) {
    return draft.modelId ? applyModelSelection(draft, draft.modelId) : draft;
  }
  if (draft.modelId && configuredModelIds.includes(draft.modelId)) {
    return applyModelSelection(draft, draft.modelId);
  }
  return applyModelSelection(draft, configuredModelIds[0]!);
}

export function OnboardingWizard({
  onComplete,
  onSkip,
  completedSteps,
}: {
  onComplete: () => void;
  onSkip: () => void;
  completedSteps: string[];
}) {
  const [activeStep, setActiveStep] = useState(STEPS[0].id);
  const [completing, setCompleting] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  const [identity, setIdentity] = useState<IdentityDraft>({
    customPersonality: "",
    personality: "strategic",
    provider: "claude",
    model: "sonnet",
    modelId: null,
    reasoningEffort: "medium",
  });

  const [project, setProject] = useState<ProjectDraft>({
    projectSummary: "",
    conventions: "",
    activeFocus: "",
  });
  const [detection, setDetection] = useState<OnboardingDetectionResult | null>(null);
  const [scanDone, setScanDone] = useState(false);

  const [linearStatus, setLinearStatus] = useState<LinearConnectionStatus | null>(null);
  const [integrationSkipped, setIntegrationSkipped] = useState(false);
  const selectedModelDescriptor = useMemo(
    () => (identity.modelId ? getModelById(identity.modelId) : null),
    [identity.modelId],
  );

  const steps: WizardStep[] = useMemo(
    () => STEPS.map((step) => ({ ...step, completed: completedSteps.includes(step.id) })),
    [completedSteps],
  );

  const populateDetectedDefaults = useCallback(() => {
    const suggested = summarizeDetection(detection);
    if (!suggested) return;
    setProject(suggested);
    setScanDone(true);
  }, [detection]);

  const saveIdentityStep = useCallback(async () => {
    if (!window.ade?.cto) return false;
    if (!identity.modelId || !availableModelIds.includes(identity.modelId)) {
      setIdentityError("Choose one of your configured models for the CTO.");
      return false;
    }
    if (identity.personality === "custom" && !identity.customPersonality.trim()) {
      setIdentityError("Add a custom personality overlay or choose one of the built-in presets.");
      return false;
    }
    const personalityPreset = getCtoPersonalityPreset(identity.personality);
    await window.ade.cto.updateIdentity({
      patch: {
        name: CTO_DISPLAY_NAME,
        persona: identity.personality === "custom"
          ? identity.customPersonality.trim()
          : `Persistent project CTO with ${personalityPreset.label.toLowerCase()} personality.`,
        personality: identity.personality,
        ...(identity.personality === "custom"
          ? { customPersonality: identity.customPersonality.trim() }
          : { customPersonality: undefined }),
        modelPreferences: {
          provider: identity.provider.trim(),
          model: identity.model.trim(),
          modelId: identity.modelId,
          reasoningEffort: identity.reasoningEffort ?? null,
        },
      },
    });
    await window.ade.cto.completeOnboardingStep({ stepId: "identity" });
    setIdentityError(null);
    return true;
  }, [availableModelIds, identity]);

  const saveProjectStep = useCallback(async () => {
    if (!window.ade?.cto) return false;
    await window.ade.cto.updateCoreMemory({
      patch: {
        projectSummary: project.projectSummary.trim(),
        criticalConventions: splitDraftList(project.conventions),
        activeFocus: splitDraftList(project.activeFocus),
      },
    });
    await window.ade.cto.completeOnboardingStep({ stepId: "project" });
    return true;
  }, [project]);

  const saveIntegrationsStep = useCallback(async () => {
    if (!window.ade?.cto) return false;
    if (!linearStatus?.connected) {
      setIntegrationSkipped(true);
    }
    await window.ade.cto.completeOnboardingStep({ stepId: "integrations" });
    return true;
  }, [linearStatus?.connected]);

  const handleAdvance = useCallback(async (stepId: string) => {
    setCompleting(true);
    setStepError(null);
    try {
      if (stepId === "identity") return await saveIdentityStep();
      if (stepId === "project") return await saveProjectStep();
      if (stepId === "integrations") return await saveIntegrationsStep();
      return true;
    } catch (err) {
      setStepError(err instanceof Error ? err.message : "Failed to save step.");
      return false;
    } finally {
      setCompleting(false);
    }
  }, [saveIdentityStep, saveIntegrationsStep, saveProjectStep]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!window.ade?.cto) return;
      try {
        const [snapshot, detectionResult, aiStatus] = await Promise.all([
          window.ade.cto.getState({}),
          window.ade.onboarding.detectDefaults().catch(() => null),
          window.ade.ai.getStatus().catch(() => null),
        ]);
        if (cancelled) return;

        const configuredModelIds = deriveConfiguredModelIds(aiStatus);
        setAvailableModelIds(configuredModelIds);
        setDetection(detectionResult);

        const defaultIdentity: IdentityDraft = {
          customPersonality: snapshot.identity?.customPersonality
            ?? (snapshot.identity?.personality === "custom" ? snapshot.identity?.persona ?? "" : ""),
          personality: snapshot.identity?.personality ?? "strategic",
          provider: snapshot.identity?.modelPreferences.provider || "claude",
          model: snapshot.identity?.modelPreferences.model || "sonnet",
          modelId: null,
          reasoningEffort: snapshot.identity?.modelPreferences.reasoningEffort ?? "medium",
        };

        const resolvedIdentityModel = resolveModelDescriptor(
          snapshot.identity?.modelPreferences.modelId
          ?? snapshot.identity?.modelPreferences.model
          ?? "",
        );
        const hydratedIdentity = resolvedIdentityModel
          ? applyModelSelection(
              {
                ...defaultIdentity,
                customPersonality: snapshot.identity?.customPersonality
                  ?? (snapshot.identity?.personality === "custom" ? snapshot.identity?.persona ?? defaultIdentity.customPersonality : defaultIdentity.customPersonality),
                personality: snapshot.identity?.personality ?? defaultIdentity.personality,
                reasoningEffort: snapshot.identity?.modelPreferences.reasoningEffort ?? defaultIdentity.reasoningEffort,
              },
              resolvedIdentityModel.id,
            )
          : {
              ...defaultIdentity,
              customPersonality: snapshot.identity?.customPersonality
                ?? (snapshot.identity?.personality === "custom" ? snapshot.identity?.persona ?? defaultIdentity.customPersonality : defaultIdentity.customPersonality),
              personality: snapshot.identity?.personality ?? defaultIdentity.personality,
              modelId: snapshot.identity?.modelPreferences.modelId ?? null,
            };

        setIdentity(coerceConfiguredModel(hydratedIdentity, configuredModelIds));

        if (snapshot.coreMemory.projectSummary) {
          setProject({
            projectSummary: snapshot.coreMemory.projectSummary,
            conventions: snapshot.coreMemory.criticalConventions.join(", "),
            activeFocus: snapshot.coreMemory.activeFocus.join(", "),
          });
        } else {
          const suggested = summarizeDetection(detectionResult);
          if (suggested) {
            setProject(suggested);
            setScanDone(true);
          }
        }
      } catch {
        // Non-fatal; onboarding stays editable even without auto-detection.
      } finally {
        if (!cancelled) {
          setLoadingModels(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLinearStatusChange = useCallback((status: LinearConnectionStatus | null) => {
    setLinearStatus(status);
    if (status?.connected) {
      setIntegrationSkipped(false);
    }
  }, []);

  const selectedPreset = getCtoPersonalityPreset(identity.personality);
  const selectedBrainSummary = selectedModelDescriptor?.displayName
    ?? (identity.modelId ? identity.modelId : `${identity.provider.trim() || "provider"} / ${identity.model.trim() || "model"}`);
  const selectedReasoningSummary = identity.reasoningEffort
    ? identity.reasoningEffort.replace(/^./, (value) => value.toUpperCase())
    : "Default";
  const detectedSignalsSummary = detection?.indicators.length
    ? detection.indicators.slice(0, 4).map((indicator) => indicator.file).join(" • ")
    : "No strong repository signals detected yet.";
  const linearSummary = linearStatus?.connected
    ? `Connected as ${linearStatus.viewerName ?? "Linear user"}`
    : integrationSkipped
      ? "Skipping Linear for now"
      : "Linear is optional";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "radial-gradient(circle at top left, rgba(56,189,248,0.14), transparent 24%), radial-gradient(circle at top right, rgba(251,191,36,0.12), transparent 24%), rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(16px)",
      }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-[28px] border shadow-float"
        style={{
          width: "min(1280px, 97vw)",
          height: "min(820px, 94vh)",
          background: "linear-gradient(180deg, #0A1016 0%, #090D14 42%, #070A10 100%)",
          borderColor: "rgba(255, 255, 255, 0.08)",
        }}
      >
        <div
          className="shrink-0 border-b px-6 py-6"
          style={{
            borderColor: "rgba(255, 255, 255, 0.06)",
            background: "radial-gradient(circle at top left, rgba(56,189,248,0.14), transparent 28%), linear-gradient(180deg, rgba(12,17,25,0.98), rgba(8,12,18,0.92))",
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-[44rem]">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-fg/40">
                CTO setup
              </div>
              <div className="mt-2 text-[1.45rem] font-semibold tracking-[-0.03em] text-fg">
                Configure a durable CTO for this project
              </div>
              <div className="mt-2 max-w-[42rem] text-[13px] leading-6 text-muted-fg/42">
                ADE owns the permanent CTO doctrine. You choose the personality overlay and the project brief that memory will carry forward through the same persistent CTO session.
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {[
                "Persistent identity",
                "Layered memory",
                "Model can change later",
                "Linear is optional",
              ].map((item, index) => (
                <div
                  key={item}
                  className="rounded-2xl border px-3 py-2 text-[11px] font-medium text-fg/72"
                  style={{
                    borderColor: index < 2 ? "rgba(56, 189, 248, 0.16)" : "rgba(255, 255, 255, 0.08)",
                    background: index < 2 ? "rgba(56, 189, 248, 0.08)" : "rgba(255,255,255,0.03)",
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <StepWizard
            steps={steps}
            activeStep={activeStep}
            onStepChange={setActiveStep}
            onNext={handleAdvance}
            onComplete={onComplete}
            onSkip={onSkip}
            completing={completing}
            nextLabel="Save and continue"
            completeLabel={linearStatus?.connected ? "Finish setup" : "Finish without Linear"}
          >
            {stepError ? (
              <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
                {stepError}
              </div>
            ) : null}

            {activeStep === "identity" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  <div className={cn(cardCls, "space-y-4 p-4")}>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-fg/40">Step 1</div>
                      <div className="mt-2 font-sans text-base font-semibold text-fg">Choose the CTO brain</div>
                      <div className="mt-1 text-xs leading-5 text-muted-fg/45">
                        Pick one of your configured models. You can change the model and thinking level at any time from the CTO chat.
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className={labelCls}>Model</div>
                      <UnifiedModelSelector
                        value={identity.modelId ?? ""}
                        availableModelIds={availableModelIds}
                        showReasoning
                        reasoningEffort={identity.reasoningEffort}
                        onReasoningEffortChange={(effort) => setIdentity((draft) => ({
                          ...draft,
                          reasoningEffort: effort,
                        }))}
                        onChange={(modelId) => {
                          setIdentity((draft) => applyModelSelection(draft, modelId));
                          setIdentityError(null);
                        }}
                      />
                      {loadingModels ? (
                        <div className="text-[11px] text-muted-fg/40">Checking which models are configured...</div>
                      ) : availableModelIds.length === 0 ? (
                        <div className="rounded-lg border border-amber-500/18 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
                          Configure at least one model in ADE settings before you finish CTO setup.
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-fg/40">Only configured models are selectable here.</div>
                      )}
                    </div>

                    <div>
                      <div className="font-sans text-sm font-semibold text-fg">Pick a personality</div>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {CTO_PERSONALITY_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => setIdentity((draft) => ({
                              ...draft,
                              personality: preset.id,
                            }))}
                            className={cn(
                              "rounded-2xl border px-3 py-3 text-left transition-all duration-200",
                              identity.personality === preset.id
                                ? "border-[rgba(56,189,248,0.28)] bg-[rgba(56,189,248,0.08)]"
                                : "border-white/[0.06] bg-[rgba(24,20,35,0.4)] hover:border-[rgba(56,189,248,0.16)]",
                            )}
                          >
                            <div className="text-xs font-medium text-fg">{preset.label}</div>
                            <div className="mt-1 text-[11px] leading-5 text-muted-fg/45">{preset.description}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {identity.personality === "custom" ? (
                      <label className="space-y-1 block">
                        <div className={labelCls}>Custom personality overlay</div>
                        <textarea
                          className={cn(textareaCls, "min-h-[140px]")}
                          rows={6}
                          placeholder="Describe the CTO's tone, standards, and decision style."
                          value={identity.customPersonality}
                          onChange={(event) => setIdentity((draft) => ({ ...draft, customPersonality: event.target.value }))}
                        />
                        <div className="text-[11px] leading-5 text-muted-fg/40">
                          This changes the CTO&apos;s personality only. ADE still keeps the doctrine, memory model, and compaction recovery fixed.
                        </div>
                      </label>
                    ) : null}

                    {identityError ? (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
                        {identityError}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-3 xl:pt-0">
                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Identity summary</div>
                    <div className="mt-3 space-y-2">
                      {[
                        { label: "Role", value: CTO_DISPLAY_NAME },
                        { label: "Model", value: selectedBrainSummary },
                        { label: "Thinking", value: selectedReasoningSummary },
                        { label: "Style", value: selectedPreset.label },
                      ].map((item) => (
                        <div key={item.label} className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                          <div className="text-[10px] text-muted-fg/50">{item.label}</div>
                          <div className="text-right text-[11px] font-medium text-fg/70">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="flex items-center gap-1.5 text-fg/70">
                      <Brain size={12} weight="duotone" style={{ color: "#38BDF8" }} />
                      <div className="text-xs font-medium">What stays stable</div>
                    </div>
                    <div className="mt-2 text-[11px] leading-5 text-muted-fg/45">
                      The model can change later without changing who the CTO is. ADE always keeps the doctrine, memory layers, and compaction recovery attached to the same CTO session.
                    </div>
                  </div>

                  <CtoPromptPreview
                    compact
                    identityOverride={{
                      name: CTO_DISPLAY_NAME,
                      personality: identity.personality,
                      customPersonality: identity.personality === "custom" ? identity.customPersonality : undefined,
                      persona: identity.personality === "custom" ? identity.customPersonality : undefined,
                    }}
                  />
                </div>
              </div>
            )}

            {activeStep === "project" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  {detection ? (
                    <div className="flex items-start justify-between gap-3 rounded-2xl border border-white/[0.05] bg-[rgba(24,20,35,0.4)] px-3 py-3">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-fg/75">
                          Repo scan found: {detection.projectTypes.join(", ") || "project signals"}
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-muted-fg/42">
                          Drafted from {detectedSignalsSummary}. Edit anything before you continue.
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={populateDetectedDefaults}
                        data-testid="cto-onboarding-apply-detection"
                      >
                        Refresh from repo
                      </Button>
                    </div>
                  ) : null}

                  <div className={cn(cardCls, "space-y-3 p-4")}>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-fg/40">Step 2</div>
                      <div className="mt-2 font-sans text-base font-semibold text-fg">Write the long-term CTO brief</div>
                      <div className="mt-1 text-xs leading-5 text-muted-fg/45">
                        This is the project memory layer, not the CTO doctrine. ADE reloads it between chats and after compaction so the CTO keeps project continuity.
                      </div>
                    </div>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Project brief</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[120px]")}
                        rows={5}
                        placeholder="What is this product, who is it for, what stack does it use, and what matters most right now?"
                        value={project.projectSummary}
                        onChange={(event) => setProject((draft) => ({ ...draft, projectSummary: event.target.value }))}
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Rules to follow</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[90px]")}
                        rows={4}
                        placeholder={"TypeScript strict\nNo force pushes to shared branches\nTests before merge"}
                        value={project.conventions}
                        onChange={(event) => setProject((draft) => ({ ...draft, conventions: event.target.value }))}
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Current priorities</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[90px]")}
                        rows={4}
                        placeholder={"Polish the CTO experience\nKeep worker continuity stable"}
                        value={project.activeFocus}
                        onChange={(event) => setProject((draft) => ({ ...draft, activeFocus: event.target.value }))}
                      />
                    </label>

                    {scanDone ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-emerald-300/70">
                        <CheckCircle size={11} weight="bold" />
                        Repo draft applied. Edit anything you want before saving.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-3 xl:pt-0">
                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">How ADE uses this</div>
                    <div className="mt-3 space-y-2">
                      {[
                        "Stored as the CTO's long-term project memory layer.",
                        "Reloaded after compaction so the CTO keeps project bearings.",
                        "Editable later without changing the immutable doctrine.",
                      ].map((item) => (
                        <div key={item} className="flex items-start gap-2 text-[11px] leading-5 text-fg/60">
                          <CheckCircle size={11} weight="fill" style={{ color: "#34D399", marginTop: 2 }} />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Memory stack</div>
                    <div className="mt-3 space-y-2">
                      {[
                        "Long-term brief: what this project is and how it should run.",
                        "Current context: active work, recent sessions, and daily carry-forward.",
                        "Durable memory: reusable decisions, conventions, patterns, and gotchas.",
                      ].map((item) => (
                        <div key={item} className="flex items-start gap-2 text-[11px] leading-5 text-fg/60">
                          <CheckCircle size={11} weight="fill" style={{ color: "#38BDF8", marginTop: 2 }} />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Current draft</div>
                    <div className="mt-3 space-y-2">
                      {[
                        { label: "Brief", value: project.projectSummary.trim() || "Nothing added yet" },
                        { label: "Rules", value: summarizeDraftList(project.conventions, "Nothing added yet") },
                        { label: "Priorities", value: summarizeDraftList(project.activeFocus, "Nothing added yet") },
                      ].map((item) => (
                        <div key={item.label} className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                          <div className="text-[10px] text-muted-fg/40">{item.label}</div>
                          <div className="mt-0.5 line-clamp-3 text-[11px] leading-5 text-fg/60">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeStep === "integrations" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  <div className={cn(cardCls, "p-4")}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-fg/40">Step 3</div>
                        <div className="mt-2 font-sans text-base font-semibold text-fg">Linear setup</div>
                      </div>
                      <div
                        className="rounded-full px-2.5 py-1 text-[10px] font-medium"
                        style={{
                          color: linearStatus?.connected ? "#34D399" : "#38BDF8",
                          background: linearStatus?.connected ? "rgba(52, 211, 153, 0.08)" : "rgba(56, 189, 248, 0.06)",
                          border: `1px solid ${linearStatus?.connected ? "rgba(52, 211, 153, 0.15)" : "rgba(56, 189, 248, 0.12)"}`,
                        }}
                      >
                        {linearSummary}
                      </div>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-fg/40">
                      Optional. Connect Linear if you want issue routing, workflow automation, and project context synced into CTO operations.
                    </div>

                    <div className="mt-3 rounded-lg border border-white/[0.05] bg-[rgba(15,12,24,0.5)] p-3">
                      <LinearConnectionPanel
                        compact
                        onStatusChange={handleLinearStatusChange}
                      />
                    </div>
                  </div>

                  {!linearStatus?.connected ? (
                    <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-[rgba(24,20,35,0.4)] px-3 py-2.5">
                      <span className="text-xs text-muted-fg/40">You can add Linear later from CTO settings.</span>
                      <button
                        type="button"
                        onClick={() => setIntegrationSkipped(true)}
                        className="text-[11px] font-medium transition-colors hover:text-fg"
                        style={{ color: "#A78BFA" }}
                      >
                        Skip
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-3 xl:pt-0">
                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Linear unlocks</div>
                    <div className="mt-3 space-y-2">
                      {[
                        "Issue routing by assignee",
                        "Workflow automation from CTO policy",
                        "A tighter loop between planning and execution",
                      ].map((item) => (
                        <div key={item} className="flex items-center gap-2 text-[11px] text-fg/55">
                          <CheckCircle size={11} weight="fill" style={{ color: "#34D399" }} />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Status</div>
                    <div className="mt-1.5 text-[11px] leading-5 text-muted-fg/45">
                      {linearStatus?.connected
                        ? `Connected${linearStatus.viewerName ? ` as ${linearStatus.viewerName}` : ""}`
                        : integrationSkipped
                          ? "Skipped for now. You can connect it later."
                          : "Not connected yet"}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </StepWizard>
        </div>
      </div>
    </div>
  );
}
