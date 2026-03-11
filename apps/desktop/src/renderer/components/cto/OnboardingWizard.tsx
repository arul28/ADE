import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  IdentificationCard,
  FolderOpen,
  Plugs,
  CheckCircle,
  Sparkle,
} from "@phosphor-icons/react";
import type {
  CtoPersonalityPreset,
  CtoSystemPromptPreview,
  LinearConnectionStatus,
  OnboardingDetectionResult,
} from "../../../shared/types";
import { StepWizard } from "./shared/StepWizard";
import type { WizardStep } from "./shared/StepWizard";
import { inputCls, labelCls, textareaCls } from "./shared/designTokens";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { LinearConnectionPanel } from "./LinearConnectionPanel";

const STEPS: WizardStep[] = [
  { id: "identity", label: "Identity", icon: IdentificationCard },
  { id: "project", label: "Project Context", icon: FolderOpen },
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
  personality: string;
  provider: string;
  model: string;
};

type ProjectDraft = {
  projectSummary: string;
  conventions: string;
  activeFocus: string;
};

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

  const [identity, setIdentity] = useState<IdentityDraft>({
    name: "CTO",
    persona: PERSONALITY_PRESETS[0].persona,
    personality: "professional",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
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
        criticalConventions: project.conventions
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        activeFocus: project.activeFocus
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
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
    try {
      if (stepId === "identity") return await saveIdentityStep();
      if (stepId === "project") return await saveProjectStep();
      if (stepId === "integrations") return await saveIntegrationsStep();
      return true;
    } finally {
      setCompleting(false);
    }
  }, [saveIdentityStep, saveIntegrationsStep, saveProjectStep]);

  useEffect(() => {
    void (async () => {
      if (!window.ade?.cto) return;
      try {
        const [snapshot, detectionResult, status] = await Promise.all([
          window.ade.cto.getState({}),
          window.ade.onboarding.detectDefaults().catch(() => null),
          window.ade.cto.getLinearConnectionStatus().catch(() => null),
        ]);
        setLinearStatus(status);
        setDetection(detectionResult);
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
    void (async () => {
      if (!window.ade?.cto) return;
      const preview = await window.ade.cto.previewSystemPrompt({
        identityOverride: {
          name: identity.name,
          persona: identity.persona,
          personality: identity.personality as CtoPersonalityPreset,
          modelPreferences: {
            provider: identity.provider,
            model: identity.model,
          },
        },
      }).catch(() => null);
      setPromptPreview(preview);
    })();
  }, [identity]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.7)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="flex flex-col overflow-hidden border border-border/30 shadow-float"
        style={{
          width: "min(920px, 92vw)",
          height: "min(620px, 88vh)",
          background: "var(--color-bg)",
        }}
      >
        <div className="shrink-0 flex items-center justify-between border-b border-border/20 px-6 py-4">
          <div>
            <div className="font-sans text-sm font-bold text-fg">Configure Your CTO</div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-fg/50">
              Set the CTO identity, bootstrap project context, and connect Linear.
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
            {activeStep === "identity" && (
              <div className="space-y-4 max-w-2xl">
                <div className="space-y-1">
                  <div className="font-sans text-xs font-bold text-fg">Identity</div>
                  <div className="font-mono text-[10px] text-muted-fg/60">
                    The CTO keeps long-lived project context, manages workers, and handles project-level coordination.
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
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
                        "border px-3 py-3 text-left transition-all",
                        identity.personality === preset.id
                          ? "border-accent/40 bg-accent/6"
                          : "border-border/15 bg-surface-recessed hover:border-border/30",
                      )}
                    >
                      <div className="font-mono text-[10px] font-bold text-fg">{preset.label}</div>
                      <div className="mt-1 font-mono text-[9px] text-muted-fg/50">{preset.description}</div>
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1">
                    <div className={labelCls}>CTO Name</div>
                    <input
                      className={inputCls}
                      placeholder="CTO"
                      value={identity.name}
                      onChange={(event) => setIdentity((draft) => ({ ...draft, name: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1">
                    <div className={labelCls}>Provider / Model</div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        className={inputCls}
                        placeholder="anthropic"
                        value={identity.provider}
                        onChange={(event) => setIdentity((draft) => ({ ...draft, provider: event.target.value }))}
                      />
                      <input
                        className={inputCls}
                        placeholder="claude-sonnet-4-6"
                        value={identity.model}
                        onChange={(event) => setIdentity((draft) => ({ ...draft, model: event.target.value }))}
                      />
                    </div>
                  </label>
                </div>

                <label className="space-y-1 block">
                  <div className={labelCls}>Persona / Instructions</div>
                  <textarea
                    className={cn(textareaCls, "min-h-[120px]")}
                    rows={5}
                    value={identity.persona}
                    onChange={(event) => setIdentity((draft) => ({ ...draft, persona: event.target.value }))}
                  />
                </label>

                {identityError && (
                  <div className="font-mono text-[10px] text-error">{identityError}</div>
                )}

                <div className="border border-accent/15 bg-accent/5 p-3">
                  <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[1px] text-muted-fg/40">
                    <Sparkle size={10} weight="bold" />
                    Prompt Preview
                  </div>
                  <div className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-fg/75" data-testid="cto-onboarding-prompt-preview">
                    {promptPreview?.prompt ?? "Preview unavailable."}
                  </div>
                </div>
              </div>
            )}

            {activeStep === "project" && (
              <div className="space-y-4 max-w-2xl">
                <div className="space-y-1">
                  <div className="font-sans text-xs font-bold text-fg">Project Context</div>
                  <div className="font-mono text-[10px] text-muted-fg/60">
                    Start from existing CTO memory or apply repository-detected defaults from onboarding.
                  </div>
                </div>

                {detection && (
                  <div className="border border-border/10 bg-card/60 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className={labelCls}>Detected Signals</div>
                        <div className="mt-1 font-mono text-[10px] text-fg/80">
                          {detection.projectTypes.join(", ") || "No strong project type detected"}
                        </div>
                        {detection.indicators.length > 0 && (
                          <div className="mt-1 font-mono text-[9px] text-muted-fg/50">
                            {detection.indicators.slice(0, 5).map((indicator) => indicator.file).join(" • ")}
                          </div>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={populateDetectedDefaults}
                        data-testid="cto-onboarding-apply-detection"
                      >
                        Use detected defaults
                      </Button>
                    </div>
                  </div>
                )}

                <label className="space-y-1 block">
                  <div className={labelCls}>Project Summary</div>
                  <textarea
                    className={cn(textareaCls, "min-h-[96px]")}
                    rows={4}
                    placeholder="What is this project and what stack does it use?"
                    value={project.projectSummary}
                    onChange={(event) => setProject((draft) => ({ ...draft, projectSummary: event.target.value }))}
                  />
                </label>

                <label className="space-y-1 block">
                  <div className={labelCls}>Key Conventions</div>
                  <input
                    className={inputCls}
                    placeholder="TypeScript strict, no any, functional React"
                    value={project.conventions}
                    onChange={(event) => setProject((draft) => ({ ...draft, conventions: event.target.value }))}
                  />
                </label>

                <label className="space-y-1 block">
                  <div className={labelCls}>Active Focus Areas</div>
                  <input
                    className={inputCls}
                    placeholder="worker-management polish, CTO onboarding"
                    value={project.activeFocus}
                    onChange={(event) => setProject((draft) => ({ ...draft, activeFocus: event.target.value }))}
                  />
                </label>

                {scanDone && (
                  <div className="flex items-center gap-2 font-mono text-[10px] text-success">
                    <CheckCircle size={12} weight="bold" />
                    Repo-detected defaults applied.
                  </div>
                )}
              </div>
            )}

            {activeStep === "integrations" && (
              <div className="space-y-4 max-w-2xl">
                <div className="space-y-1">
                  <div className="font-sans text-xs font-bold text-fg">Integrations</div>
                  <div className="font-mono text-[10px] text-muted-fg/60">
                    Connect Linear now for issue intake, or finish setup and configure it later from the CTO tab.
                  </div>
                </div>

                <div className="border border-border/10 bg-card/60 p-4">
                  <LinearConnectionPanel
                    compact
                    onStatusChange={(status) => {
                      setLinearStatus(status);
                      if (status?.connected) setIntegrationSkipped(false);
                    }}
                  />
                </div>

                {!linearStatus?.connected && (
                  <div className="flex items-center justify-between gap-3 border border-border/10 bg-surface-recessed px-3 py-2">
                    <div className="font-mono text-[10px] text-muted-fg/70">
                      Finish setup without Linear and connect it later if you prefer.
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIntegrationSkipped(true)}
                    >
                      Skip Linear for now
                    </Button>
                  </div>
                )}

                <div className="font-mono text-[9px] text-muted-fg/45">
                  {linearStatus?.connected
                    ? `Connected as ${linearStatus.viewerName ?? "Linear user"}.`
                    : integrationSkipped
                      ? "Linear setup will stay available from the CTO tab after onboarding."
                      : "Linear is optional for now. You can still finish setup without it."}
                </div>
              </div>
            )}
          </StepWizard>
        </div>
      </div>
    </div>
  );
}
