import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  IdentificationCard,
  FolderOpen,
  Plugs,
  CheckCircle,
  Sparkle,
} from "@phosphor-icons/react";
import { getModelById } from "../../../shared/modelRegistry";
import type {
  CtoPersonalityPreset,
  CtoSystemPromptPreview,
  LinearConnectionStatus,
  OnboardingDetectionResult,
} from "../../../shared/types";
import { StepWizard } from "./shared/StepWizard";
import type { WizardStep } from "./shared/StepWizard";
import { cardCls, inputCls, labelCls, recessedPanelCls, textareaCls } from "./shared/designTokens";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { LinearConnectionPanel } from "./LinearConnectionPanel";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";

const STEPS: WizardStep[] = [
  { id: "identity", label: "Identity", icon: IdentificationCard },
  { id: "project", label: "Project", icon: FolderOpen },
  { id: "integrations", label: "Integrations", icon: Plugs },
];

const PERSONALITY_PRESETS = [
  {
    id: "professional",
    label: "Professional",
    description: "Structured, calm, and leadership-oriented.",
    persona:
      "You are the technical leader for this project. Guide architecture decisions, review code quality, and coordinate the engineering team.",
  },
  {
    id: "casual",
    label: "Casual",
    description: "Warm and collaborative without losing rigor.",
    persona:
      "You are the project's technical lead. Stay approachable, guide implementation decisions, and help the team keep momentum.",
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Concise, decisive, and low-noise.",
    persona:
      "You are the technical lead for this project. Be direct, decisive, and concise while maintaining project continuity.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Start from the current prompt and tune it yourself.",
    persona:
      "You are the technical leader for this project. Guide architecture decisions, review code quality, and coordinate the engineering team.",
  },
] as const;

type IdentityDraft = {
  name: string;
  persona: string;
  personality: CtoPersonalityPreset;
  provider: string;
  model: string;
  modelId?: string | null;
};

type ProjectDraft = {
  projectSummary: string;
  conventions: string;
  activeFocus: string;
};

type StartingBrainPreset = {
  modelId: string;
  provider: string;
  model: string;
  label: string;
  detail: string;
};

const STARTING_BRAIN_PRESETS: StartingBrainPreset[] = [
  {
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    detail: "Best default for a strong persistent CTO with tool use.",
  },
  {
    modelId: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    detail: "Fastest lightweight starting brain when you want lower latency.",
  },
  {
    modelId: "openai/gpt-5.4-codex",
    provider: "openai",
    model: "gpt-5.4",
    label: "GPT-5.4",
    detail: "Great if you want the Codex app-server path from the start.",
  },
  {
    modelId: "openai/gpt-5.3-codex",
    provider: "openai",
    model: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    detail: "Fast coding-oriented default for a more tactical CTO brain.",
  },
];

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
    projectSummary: `Detected ${projectTypes.join(", ") || "project"} setup from ${signals.join(", ") || "local repository signals"}.`,
    conventions: projectTypes.map((type) => `${type} conventions`).join(", "),
    activeFocus: projectTypes.length ? `stabilize ${projectTypes[0]} workflows` : "establish project context",
  };
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

  const [identity, setIdentity] = useState<IdentityDraft>({
    name: "CTO",
    persona: PERSONALITY_PRESETS[0].persona,
    personality: "professional",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    modelId: "anthropic/claude-sonnet-4-6",
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
  const [promptPreview, setPromptPreview] = useState<CtoSystemPromptPreview | null>(null);
  const promptPreviewRequestSeqRef = useRef(0);
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
    if (!identity.name.trim() || !identity.provider.trim() || !identity.model.trim()) {
      setIdentityError("Name, provider, and model are required.");
      return false;
    }
    await window.ade.cto.updateIdentity({
      patch: {
        name: identity.name.trim(),
        persona: identity.persona.trim(),
        personality: identity.personality,
        modelPreferences: {
          provider: identity.provider.trim(),
          model: identity.model.trim(),
          ...(identity.modelId ? { modelId: identity.modelId } : {}),
        },
      },
    });
    await window.ade.cto.completeOnboardingStep({ stepId: "identity" });
    setIdentityError(null);
    return true;
  }, [identity]);

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
    void (async () => {
      if (!window.ade?.cto) return;
      try {
        const [snapshot, detectionResult] = await Promise.all([
          window.ade.cto.getState({}),
          window.ade.onboarding.detectDefaults().catch(() => null),
        ]);
        setDetection(detectionResult);
        if (snapshot.identity) {
          setIdentity({
            name: snapshot.identity.name || "CTO",
            persona: snapshot.identity.persona || PERSONALITY_PRESETS[0].persona,
            personality: snapshot.identity.personality ?? "professional",
            provider: snapshot.identity.modelPreferences.provider || "anthropic",
            model: snapshot.identity.modelPreferences.model || "claude-sonnet-4-6",
            modelId: snapshot.identity.modelPreferences.modelId ?? null,
          });
        }
        if (snapshot.coreMemory.projectSummary) {
          setProject({
            projectSummary: snapshot.coreMemory.projectSummary,
            conventions: snapshot.coreMemory.criticalConventions.join(", "),
            activeFocus: snapshot.coreMemory.activeFocus.join(", "),
          });
        } else {
          const suggested = summarizeDetection(detectionResult);
          if (suggested) setProject(suggested);
        }
      } catch {
        // Non-fatal; onboarding stays editable even without auto-detection.
      }
    })();
  }, []);

  useEffect(() => {
    if (activeStep !== "identity" || !window.ade?.cto) return;
    const ctoBridge = window.ade.cto;
    const requestSeq = promptPreviewRequestSeqRef.current + 1;
    promptPreviewRequestSeqRef.current = requestSeq;
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void ctoBridge.previewSystemPrompt({
        identityOverride: {
          name: identity.name,
          persona: identity.persona,
          personality: identity.personality as CtoPersonalityPreset,
          modelPreferences: {
            provider: identity.provider,
            model: identity.model,
            ...(identity.modelId ? { modelId: identity.modelId } : {}),
          },
        },
      }).then((preview) => {
        if (!cancelled && promptPreviewRequestSeqRef.current === requestSeq) {
          setPromptPreview(preview);
        }
      }).catch(() => {
        if (!cancelled && promptPreviewRequestSeqRef.current === requestSeq) {
          setPromptPreview(null);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    activeStep,
    identity.model,
    identity.name,
    identity.persona,
    identity.personality,
    identity.provider,
    identity.modelId,
  ]);

  const handleLinearStatusChange = useCallback((status: LinearConnectionStatus | null) => {
    setLinearStatus(status);
    if (status?.connected) {
      setIntegrationSkipped(false);
    }
  }, []);

  const selectedBrainSummary = selectedModelDescriptor?.displayName
    ?? STARTING_BRAIN_PRESETS.find((preset) => preset.modelId === identity.modelId)?.label
    ?? `${identity.provider.trim() || "provider"} / ${identity.model.trim() || "model"}`;
  const detectedSignalsSummary = detection?.indicators.length
    ? detection.indicators.slice(0, 4).map((indicator) => indicator.file).join(" • ")
    : "No strong repository signals detected yet.";
  const linearSummary = linearStatus?.connected
    ? `Connected as ${linearStatus.viewerName ?? "Linear user"}`
    : integrationSkipped
      ? "Skipping Linear for now"
      : "Linear optional";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.75)", backdropFilter: "blur(12px)" }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-2xl border shadow-float"
        style={{
          width: "min(1200px, 96vw)",
          height: "min(780px, 94vh)",
          background: "#0C0A14",
          borderColor: "rgba(167, 139, 250, 0.1)",
        }}
      >
        <div
          className="shrink-0 border-b px-6 py-5"
          style={{ borderColor: "rgba(167, 139, 250, 0.08)" }}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold tracking-[-0.02em] text-fg">
                Set up your CTO
              </div>
              <div className="mt-0.5 text-xs text-muted-fg/45">
                Name it, give it context, connect integrations.
              </div>
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
            nextLabel="Save & Continue"
            completeLabel={linearStatus?.connected ? "Finish Setup" : "Finish Without Linear"}
          >
            {stepError ? (
              <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
                {stepError}
              </div>
            ) : null}
            {activeStep === "identity" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  <div className={cn(cardCls, "space-y-3 p-4")}>
                    <div>
                      <div className="font-sans text-sm font-semibold text-fg">Model</div>
                      <div className="mt-2">
                        <UnifiedModelSelector
                          value={identity.modelId ?? ""}
                          onChange={(modelId) => {
                            const model = getModelById(modelId);
                            if (model) {
                              setIdentity((draft) => ({
                                ...draft,
                                provider: model.family,
                                model: model.shortId ?? model.id.split("/").pop() ?? model.id,
                                modelId,
                              }));
                            }
                          }}
                        />
                      </div>
                    </div>

                    <div className="font-sans text-sm font-semibold text-fg">Personality</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {PERSONALITY_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setIdentity((draft) => ({
                            ...draft,
                            personality: preset.id,
                            persona: preset.id === "custom" ? draft.persona : preset.persona,
                          }))}
                          className={cn(
                            "rounded-lg border px-3 py-2.5 text-left transition-all duration-200",
                            identity.personality === preset.id
                              ? "border-[rgba(167,139,250,0.35)] bg-[rgba(167,139,250,0.08)]"
                              : "border-white/[0.06] bg-[rgba(24,20,35,0.4)] hover:border-[rgba(167,139,250,0.18)]",
                          )}
                        >
                          <div className="text-xs font-medium text-fg">{preset.label}</div>
                          <div className="mt-0.5 text-[11px] text-muted-fg/45">{preset.description}</div>
                        </button>
                      ))}
                    </div>

                    <label className="space-y-1">
                      <div className={labelCls}>Name</div>
                      <input
                        className={cn(inputCls, "max-w-xs")}
                        placeholder="CTO"
                        value={identity.name}
                        onChange={(event) => setIdentity((draft) => ({ ...draft, name: event.target.value }))}
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Persona</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[120px]")}
                        rows={5}
                        value={identity.persona}
                        onChange={(event) => setIdentity((draft) => ({ ...draft, persona: event.target.value }))}
                      />
                    </label>

                    {identityError ? (
                      <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
                        {identityError}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-lg border p-3" style={{ borderColor: "rgba(167, 139, 250, 0.12)", background: "rgba(167, 139, 250, 0.04)" }}>
                    <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">
                      <Sparkle size={10} weight="bold" />
                      System prompt preview
                    </div>
                    <div className="max-h-36 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-fg/60" data-testid="cto-onboarding-prompt-preview">
                      {promptPreview?.prompt ?? "Preview unavailable."}
                    </div>
                  </div>
                </div>

                <div className="space-y-3 xl:pt-0">
                  <div className={cn(recessedPanelCls, "p-3")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Summary</div>
                    <div className="mt-3 space-y-2">
                      {[
                        { label: "Identity", value: identity.name.trim() || "CTO" },
                        { label: "Model", value: selectedBrainSummary },
                        { label: "Memory", value: "Persistent" },
                      ].map((item) => (
                        <div key={item.label} className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                          <div className="text-[10px] text-muted-fg/50">{item.label}</div>
                          <div className="text-[11px] font-medium text-fg/70">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-3")}>
                    <div className="flex items-center gap-1.5 text-fg/70">
                      <Brain size={12} weight="duotone" style={{ color: "#A78BFA" }} />
                      <div className="text-xs font-medium">Model swaps</div>
                    </div>
                    <div className="mt-2 text-[11px] leading-5 text-muted-fg/45">
                      Changing the model later keeps identity and memory intact.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeStep === "project" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-4">
                  {detection ? (
                    <div className="flex items-center justify-between rounded-lg border border-white/[0.05] bg-[rgba(24,20,35,0.4)] px-3 py-2.5">
                      <div className="text-xs text-fg/60">
                        Detected: {detection.projectTypes.join(", ") || "project"}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={populateDetectedDefaults}
                        data-testid="cto-onboarding-apply-detection"
                      >
                        Auto-fill
                      </Button>
                    </div>
                  ) : null}

                  <div className={cn(cardCls, "space-y-3 p-4")}>
                    <div className="font-sans text-sm font-semibold text-fg">Project context</div>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Summary</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[100px]")}
                        rows={4}
                        placeholder="What is this project, who is it for, and what stack does it use?"
                        value={project.projectSummary}
                        onChange={(event) => setProject((draft) => ({ ...draft, projectSummary: event.target.value }))}
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Conventions</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[80px]")}
                        rows={3}
                        placeholder={"TypeScript strict\nNo force pushes to shared branches"}
                        value={project.conventions}
                        onChange={(event) => setProject((draft) => ({ ...draft, conventions: event.target.value }))}
                      />
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Current focus</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[80px]")}
                        rows={3}
                        placeholder={"CTO polish\nworker continuity"}
                        value={project.activeFocus}
                        onChange={(event) => setProject((draft) => ({ ...draft, activeFocus: event.target.value }))}
                      />
                    </label>

                    {scanDone ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-emerald-300/70">
                        <CheckCircle size={11} weight="bold" />
                        Defaults applied
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-3 xl:pt-0">
                  <div className={cn(recessedPanelCls, "p-3")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Preview</div>
                    <div className="mt-3 space-y-2">
                      {[
                        { label: "Summary", value: project.projectSummary.trim() || "—" },
                        { label: "Conventions", value: summarizeDraftList(project.conventions, "—") },
                        { label: "Focus", value: summarizeDraftList(project.activeFocus, "—") },
                      ].map((item) => (
                        <div key={item.label} className="flex flex-col gap-0.5 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-2">
                          <div className="text-[10px] text-muted-fg/40">{item.label}</div>
                          <div className="text-[11px] text-fg/60 line-clamp-2">{item.value}</div>
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
                      <div className="font-sans text-sm font-semibold text-fg">Linear</div>
                      <div className="rounded-full px-2.5 py-1 text-[10px] font-medium" style={{
                        color: linearStatus?.connected ? "#34D399" : "#A78BFA",
                        background: linearStatus?.connected ? "rgba(52, 211, 153, 0.08)" : "rgba(167, 139, 250, 0.06)",
                        border: `1px solid ${linearStatus?.connected ? "rgba(52, 211, 153, 0.15)" : "rgba(167, 139, 250, 0.1)"}`,
                      }}>
                        {linearSummary}
                      </div>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-fg/40">
                      Optional. Enables issue routing and workflow automation.
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
                      <span className="text-xs text-muted-fg/40">You can add Linear later from settings.</span>
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
                  <div className={cn(recessedPanelCls, "p-3")}>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-fg/50">Linear unlocks</div>
                    <div className="mt-3 space-y-2">
                      {[
                        "Issue routing by assignee",
                        "Living workpad comments",
                        "PR proof links on close",
                      ].map((item) => (
                        <div key={item} className="flex items-center gap-2 text-[11px] text-fg/55">
                          <CheckCircle size={11} weight="fill" style={{ color: "#34D399" }} />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-3")}>
                    <div className="flex items-center gap-1.5" style={{ color: "#A78BFA" }}>
                      <Plugs size={12} weight="duotone" />
                      <div className="text-xs font-medium">Status</div>
                    </div>
                    <div className="mt-1.5 text-[11px] leading-5 text-muted-fg/45">
                      {linearStatus?.connected
                        ? `Connected${linearStatus.viewerName ? ` as ${linearStatus.viewerName}` : ""}`
                        : integrationSkipped
                          ? "Skipped — add later from settings"
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
