import React, { useCallback, useEffect, useState } from "react";
import {
  IdentificationCard,
  FolderOpen,
  Plugs,
  CheckCircle,
  CircleNotch,
} from "@phosphor-icons/react";
import type {
  CtoLinearProject,
  CtoOnboardingState,
  LinearConnectionStatus,
} from "../../../shared/types";
import { StepWizard } from "./shared/StepWizard";
import type { WizardStep } from "./shared/StepWizard";
import { ConnectionStatusDot } from "./shared/ConnectionStatusDot";
import { inputCls, labelCls, selectCls, textareaCls } from "./shared/designTokens";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

const STEPS: WizardStep[] = [
  { id: "identity", label: "Identity", icon: IdentificationCard },
  { id: "project", label: "Project Context", icon: FolderOpen },
  { id: "integrations", label: "Integrations", icon: Plugs },
];

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

  // Identity step state
  const [identity, setIdentity] = useState<IdentityDraft>({
    name: "CTO",
    persona: "You are the technical leader for this project. Guide architecture decisions, review code quality, and coordinate the engineering team.",
    personality: "professional",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });

  // Project step state
  const [project, setProject] = useState<ProjectDraft>({
    projectSummary: "",
    conventions: "",
    activeFocus: "",
  });
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);

  // Integrations step state
  const [linearToken, setLinearToken] = useState("");
  const [linearStatus, setLinearStatus] = useState<LinearConnectionStatus | null>(null);
  const [linearProjects, setLinearProjects] = useState<CtoLinearProject[]>([]);
  const [validatingToken, setValidatingToken] = useState(false);

  const steps: WizardStep[] = STEPS.map((s) => ({
    ...s,
    completed: completedSteps.includes(s.id),
  }));

  const handleStepChange = (stepId: string) => {
    setActiveStep(stepId);
  };

  const saveIdentityStep = useCallback(async () => {
    if (!window.ade?.cto) return;
    await window.ade.cto.updateIdentity({
      patch: {
        name: identity.name,
        persona: identity.persona,
        personality: identity.personality,
        modelPreferences: { provider: identity.provider, model: identity.model },
      },
    });
    await window.ade.cto.completeOnboardingStep({ stepId: "identity" });
  }, [identity]);

  const saveProjectStep = useCallback(async () => {
    if (!window.ade?.cto) return;
    const conventions = project.conventions
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const focus = project.activeFocus
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await window.ade.cto.updateCoreMemory({
      patch: {
        projectSummary: project.projectSummary,
        criticalConventions: conventions,
        activeFocus: focus,
      },
    });
    await window.ade.cto.completeOnboardingStep({ stepId: "project" });
  }, [project]);

  const saveIntegrationsStep = useCallback(async () => {
    if (!window.ade?.cto) return;
    await window.ade.cto.completeOnboardingStep({ stepId: "integrations" });
  }, []);

  const handleNext = useCallback(async () => {
    setCompleting(true);
    try {
      if (activeStep === "identity") {
        await saveIdentityStep();
        setActiveStep("project");
      } else if (activeStep === "project") {
        await saveProjectStep();
        setActiveStep("integrations");
      } else if (activeStep === "integrations") {
        await saveIntegrationsStep();
        onComplete();
      }
    } catch {
      // non-fatal
    } finally {
      setCompleting(false);
    }
  }, [activeStep, saveIdentityStep, saveProjectStep, saveIntegrationsStep, onComplete]);

  const handleValidateToken = useCallback(async () => {
    if (!window.ade?.cto || !linearToken.trim()) return;
    setValidatingToken(true);
    try {
      const status = await window.ade.cto.setLinearToken({ token: linearToken.trim() });
      setLinearStatus(status);
      if (status.connected) {
        const projects = await window.ade.cto.getLinearProjects();
        setLinearProjects(projects);
      }
    } catch {
      setLinearStatus({ tokenStored: false, connected: false, viewerId: null, viewerName: null, checkedAt: new Date().toISOString(), message: "Validation failed." });
    } finally {
      setValidatingToken(false);
    }
  }, [linearToken]);

  // Auto-detect project on mount
  useEffect(() => {
    if (project.projectSummary) return;
    void (async () => {
      if (!window.ade?.cto) return;
      try {
        const snapshot = await window.ade.cto.getState({});
        if (snapshot.coreMemory.projectSummary) {
          setProject((p) => ({
            ...p,
            projectSummary: snapshot.coreMemory.projectSummary,
            conventions: snapshot.coreMemory.criticalConventions.join(", "),
            activeFocus: snapshot.coreMemory.activeFocus.join(", "),
          }));
        }
      } catch { /* non-fatal */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="flex flex-col border border-border/30 shadow-float overflow-hidden"
        style={{
          width: "min(780px, 90vw)",
          height: "min(560px, 85vh)",
          background: "var(--color-bg)",
        }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border/20">
          <div>
            <div className="font-sans text-sm font-bold text-fg">Configure Your CTO</div>
            <div className="font-mono text-[10px] text-muted-fg/50 mt-0.5">
              Set up identity, project context, and integrations
            </div>
          </div>
        </div>

        {/* Wizard body */}
        <div className="flex-1 min-h-0">
          <StepWizard
            steps={steps}
            activeStep={activeStep}
            onStepChange={handleStepChange}
            onComplete={handleNext}
            onSkip={onSkip}
            completing={completing}
            nextLabel="Save & Continue"
            completeLabel="Finish Setup"
          >
            {/* Step 1: Identity */}
            {activeStep === "identity" && (
              <div className="space-y-4 max-w-lg">
                <div className="font-sans text-xs font-bold text-fg mb-1">Name & Personality</div>
                <label className="space-y-1 block">
                  <div className={labelCls}>CTO Name</div>
                  <input
                    className={inputCls}
                    placeholder="CTO"
                    value={identity.name}
                    onChange={(e) => setIdentity((d) => ({ ...d, name: e.target.value }))}
                  />
                </label>

                <label className="space-y-1 block">
                  <div className={labelCls}>Personality</div>
                  <select
                    className={selectCls}
                    value={identity.personality}
                    onChange={(e) => setIdentity((d) => ({ ...d, personality: e.target.value }))}
                  >
                    <option value="professional">Professional</option>
                    <option value="casual">Casual</option>
                    <option value="minimal">Minimal</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>

                <label className="space-y-1 block">
                  <div className={labelCls}>Persona / Instructions</div>
                  <textarea
                    className={cn(textareaCls, "min-h-[80px]")}
                    rows={3}
                    value={identity.persona}
                    onChange={(e) => setIdentity((d) => ({ ...d, persona: e.target.value }))}
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1">
                    <div className={labelCls}>Provider</div>
                    <input
                      className={inputCls}
                      placeholder="anthropic"
                      value={identity.provider}
                      onChange={(e) => setIdentity((d) => ({ ...d, provider: e.target.value }))}
                    />
                  </label>
                  <label className="space-y-1">
                    <div className={labelCls}>Model</div>
                    <input
                      className={inputCls}
                      placeholder="claude-sonnet-4-6"
                      value={identity.model}
                      onChange={(e) => setIdentity((d) => ({ ...d, model: e.target.value }))}
                    />
                  </label>
                </div>

                {/* Preview card */}
                <div className="border border-accent/15 bg-accent/5 p-3 mt-3">
                  <div className="font-mono text-[9px] text-muted-fg/40 uppercase tracking-[1px] mb-1">Preview</div>
                  <div className="font-mono text-[10px] text-fg/70 leading-relaxed">
                    &quot;Hi, I&apos;m <span className="text-accent font-bold">{identity.name || "CTO"}</span>.
                    I&apos;ll be your technical leader for this project.&quot;
                  </div>
                </div>
              </div>
            )}

            {/* Step 2: Project Context */}
            {activeStep === "project" && (
              <div className="space-y-4 max-w-lg">
                <div className="font-sans text-xs font-bold text-fg mb-1">Project Context</div>

                <label className="space-y-1 block">
                  <div className={labelCls}>Project Summary</div>
                  <textarea
                    className={cn(textareaCls, "min-h-[80px]")}
                    rows={3}
                    placeholder="What is this project? What tech stack does it use?"
                    value={project.projectSummary}
                    onChange={(e) => setProject((d) => ({ ...d, projectSummary: e.target.value }))}
                  />
                </label>

                <label className="space-y-1 block">
                  <div className={labelCls}>Key Conventions</div>
                  <input
                    className={inputCls}
                    placeholder="TypeScript strict, no any, functional React (comma-separated)"
                    value={project.conventions}
                    onChange={(e) => setProject((d) => ({ ...d, conventions: e.target.value }))}
                  />
                </label>

                <label className="space-y-1 block">
                  <div className={labelCls}>Active Focus Areas</div>
                  <input
                    className={inputCls}
                    placeholder="performance optimization, auth system (comma-separated)"
                    value={project.activeFocus}
                    onChange={(e) => setProject((d) => ({ ...d, activeFocus: e.target.value }))}
                  />
                </label>

                {scanDone && (
                  <div className="flex items-center gap-2 text-success font-mono text-[10px]">
                    <CheckCircle size={12} weight="bold" />
                    Project context detected and applied.
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Integrations */}
            {activeStep === "integrations" && (
              <div className="space-y-4 max-w-lg">
                <div className="font-sans text-xs font-bold text-fg mb-1">Connect Integrations</div>

                {/* Linear */}
                <div className="border border-border/10 bg-card/60 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-muted-fg/60">
                      Linear
                    </span>
                    {linearStatus && (
                      <ConnectionStatusDot
                        status={linearStatus.connected ? "connected" : "disconnected"}
                        label={linearStatus.connected ? linearStatus.viewerName ?? "Connected" : "Not connected"}
                      />
                    )}
                  </div>

                  <div className="flex gap-2">
                    <input
                      className={cn(inputCls, "flex-1")}
                      type="password"
                      placeholder="lin_api_..."
                      value={linearToken}
                      onChange={(e) => setLinearToken(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      onClick={handleValidateToken}
                      disabled={validatingToken || !linearToken.trim()}
                    >
                      {validatingToken ? (
                        <CircleNotch size={10} className="animate-spin" />
                      ) : (
                        "Validate"
                      )}
                    </Button>
                  </div>

                  {linearStatus?.message && !linearStatus.connected && (
                    <div className="font-mono text-[10px] text-error">{linearStatus.message}</div>
                  )}

                  {linearProjects.length > 0 && (
                    <div className="space-y-1">
                      <div className={labelCls}>Available Projects</div>
                      <div className="max-h-32 overflow-y-auto space-y-1">
                        {linearProjects.map((p) => (
                          <div
                            key={p.id}
                            className="flex items-center gap-2 px-2 py-1.5 bg-surface-recessed border border-border/10"
                          >
                            <span className="font-mono text-[10px] text-fg">{p.name}</span>
                            <span className="font-mono text-[9px] text-muted-fg/40">{p.teamName}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="font-mono text-[9px] text-muted-fg/40 mt-2">
                  You can configure additional integrations later from the Settings tab.
                </div>
              </div>
            )}
          </StepWizard>
        </div>
      </div>
    </div>
  );
}
