import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Brain,
  ArrowSquareOut,
  GitBranch,
  IdentificationCard,
  FolderOpen,
  Plugs,
  ShieldCheck,
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

const STEPS: WizardStep[] = [
  { id: "identity", label: "Identity", description: "Name the operator and choose its first brain.", icon: IdentificationCard },
  { id: "project", label: "Project Context", description: "Seed the memory it should carry forward.", icon: FolderOpen },
  { id: "integrations", label: "Integrations", description: "Connect Linear now or finish setup fast.", icon: Plugs },
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
      style={{ background: "rgba(0, 0, 0, 0.7)", backdropFilter: "blur(8px)" }}
    >
      <div
        className="flex flex-col overflow-hidden border border-border/30 shadow-float"
        style={{
          width: "min(1180px, 96vw)",
          height: "min(760px, 92vh)",
          background: "var(--color-bg)",
        }}
      >
        <div
          className="shrink-0 border-b border-border/20 px-6 py-6"
          style={{
            background:
              "radial-gradient(circle at top left, rgba(34, 211, 238, 0.18), transparent 34%), radial-gradient(circle at bottom right, rgba(59, 130, 246, 0.12), transparent 38%), linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)",
          }}
        >
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl">
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300/80">
                Configure your CTO
              </div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-fg">
                Stand up a persistent project operator
              </div>
              <div className="mt-2 max-w-2xl text-sm leading-6 text-fg/72">
                This is not a throwaway chat. You are creating one long-running identity for the workspace: it keeps memory, can swap brains later, and starts from a full-access operator model by default.
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {[
                  { label: "Persistent identity", detail: "One CTO persona for the whole workspace." },
                  { label: "Brain can change", detail: "Model swaps do not reset memory or who this is." },
                  { label: "Linear optional", detail: "Finish setup now and connect issue workflows later." },
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl border border-white/[0.08] bg-black/20 px-4 py-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/48">{item.label}</div>
                    <div className="mt-2 text-xs leading-5 text-fg/72">{item.detail}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="grid gap-3 xl:w-[300px]">
              <div className="rounded-2xl border border-white/[0.08] bg-black/20 px-4 py-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">What you leave with</div>
                <div className="mt-3 space-y-2 text-xs leading-5 text-fg/74">
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} weight="fill" className="mt-0.5 text-emerald-300" />
                    <span>A named CTO identity with a starting brain.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} weight="fill" className="mt-0.5 text-emerald-300" />
                    <span>Seeded project memory that carries forward after this wizard.</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle size={14} weight="fill" className="mt-0.5 text-emerald-300" />
                    <span>Optional Linear routing, without blocking first-run setup.</span>
                  </div>
                </div>
              </div>
              <div className="rounded-2xl border border-cyan-400/18 bg-cyan-500/[0.08] px-4 py-3">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-100">OpenClaw-style mental model</div>
                <div className="mt-2 text-xs leading-5 text-cyan-50/82">
                  Treat this like one always-on operator with durable memory. You can change the active model later without creating a different person.
                </div>
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
            {activeStep === "identity" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-5">
                  <div className={cn(cardCls, "p-5")}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Step 1 · Identity</div>
                    <div className="mt-2 text-xl font-semibold tracking-[-0.02em] text-fg">
                      Define the persistent operator people are talking to
                    </div>
                    <div className="mt-2 max-w-3xl text-sm leading-6 text-fg/72">
                      You are creating one long-running CTO identity for this workspace. The identity, memory, and session continuity persist over time. The model is just the starting brain.
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      {[
                        { label: "What persists", detail: "Name, persona, memory, and operator continuity." },
                        { label: "What can change later", detail: "Provider, model, and tool routing." },
                        { label: "Default runtime", detail: "Full access by default for a trusted operator surface." },
                      ].map((item) => (
                        <div key={item.label} className="rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/48">{item.label}</div>
                          <div className="mt-2 text-xs leading-5 text-fg/72">{item.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(cardCls, "p-5")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-sans text-sm font-semibold text-fg">Choose a starting brain</div>
                        <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                          Pick a sensible starting point. You can swap this later without resetting the CTO&apos;s memory or identity.
                        </div>
                      </div>
                      <div className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-100">
                        Brain swaps are safe
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {STARTING_BRAIN_PRESETS.map((preset) => {
                        const isSelected = identity.modelId === preset.modelId;
                        return (
                          <button
                            key={preset.modelId}
                            type="button"
                            onClick={() => setIdentity((draft) => ({
                              ...draft,
                              provider: preset.provider,
                              model: preset.model,
                              modelId: preset.modelId,
                            }))}
                            className={cn(
                              "rounded-2xl border px-4 py-3 text-left transition-all",
                              isSelected
                                ? "border-accent/40 bg-accent/8"
                                : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.03]",
                            )}
                          >
                            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">
                              {preset.provider}
                            </div>
                            <div className="mt-2 text-sm font-semibold text-fg">{preset.label}</div>
                            <div className="mt-1 text-xs leading-5 text-muted-fg/65">{preset.detail}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className={cn(cardCls, "space-y-4 p-5")}>
                    <div>
                      <div className="font-sans text-sm font-semibold text-fg">Shape the operator</div>
                      <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                        Give the CTO a clear name, decide its tone, and set the raw provider/model values if you want something custom.
                      </div>
                    </div>

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
                            "rounded-2xl border px-4 py-3 text-left transition-all",
                            identity.personality === preset.id
                              ? "border-accent/40 bg-accent/8"
                              : "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.03]",
                          )}
                        >
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg">{preset.label}</div>
                          <div className="mt-1 text-xs leading-5 text-muted-fg/62">{preset.description}</div>
                        </button>
                      ))}
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="space-y-1">
                        <div className={labelCls}>CTO Name</div>
                        <input
                          className={inputCls}
                          placeholder="CTO"
                          value={identity.name}
                          onChange={(event) => setIdentity((draft) => ({ ...draft, name: event.target.value }))}
                        />
                        <div className="text-[11px] leading-5 text-muted-fg/58">
                          This is the name people will see when they talk to the persistent CTO.
                        </div>
                      </label>
                      <label className="space-y-1">
                        <div className={labelCls}>Starting brain</div>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            className={inputCls}
                            placeholder="anthropic"
                            value={identity.provider}
                            onChange={(event) => setIdentity((draft) => ({ ...draft, provider: event.target.value, modelId: null }))}
                          />
                          <input
                            className={inputCls}
                            placeholder="claude-sonnet-4-6"
                            value={identity.model}
                            onChange={(event) => setIdentity((draft) => ({ ...draft, model: event.target.value, modelId: null }))}
                          />
                        </div>
                        <div className="text-[11px] leading-5 text-muted-fg/58">
                          These fields are the raw routing preference. Keep them simple unless you need a specific provider/model pairing.
                        </div>
                      </label>
                    </div>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Persona / Instructions</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[140px]")}
                        rows={6}
                        value={identity.persona}
                        onChange={(event) => setIdentity((draft) => ({ ...draft, persona: event.target.value }))}
                      />
                      <div className="text-[11px] leading-5 text-muted-fg/58">
                        This becomes the durable operator persona, not a one-off prompt for a single chat.
                      </div>
                    </label>

                    {identityError ? (
                      <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 font-mono text-[10px] text-red-200">
                        {identityError}
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-accent/15 bg-accent/5 p-4">
                    <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[1px] text-muted-fg/42">
                      <Sparkle size={10} weight="bold" />
                      Prompt Preview
                    </div>
                    <div className="max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-fg/76" data-testid="cto-onboarding-prompt-preview">
                      {promptPreview?.prompt ?? "Preview unavailable."}
                    </div>
                  </div>
                </div>

                <div className="space-y-4 xl:pt-1">
                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">What this creates</div>
                    <div className="mt-4 space-y-3">
                      {[
                        { label: "Identity", value: identity.name.trim() || "CTO" },
                        { label: "Starting brain", value: selectedBrainSummary },
                        { label: "Permissions", value: "Full access by default" },
                        { label: "Memory", value: "Persistent project memory attached to this operator" },
                      ].map((item) => (
                        <div key={item.label} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
                          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-fg/42">{item.label}</div>
                          <div className="mt-1 text-xs leading-5 text-fg/78">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="flex items-center gap-2 text-fg">
                      <Brain size={14} weight="duotone" className="text-cyan-200" />
                      <div className="font-sans text-sm font-semibold">How brain changes work</div>
                    </div>
                    <div className="mt-3 space-y-2 text-xs leading-5 text-muted-fg/68">
                      <div>You are not locking the CTO to one model family forever.</div>
                      <div>Changing the active model later swaps the brain, not the person.</div>
                      <div>That means the identity, memory, and long-running context remain intact.</div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-emerald-400/18 bg-emerald-500/[0.08] p-4">
                    <div className="flex items-center gap-2 text-emerald-100">
                      <ShieldCheck size={14} weight="duotone" />
                      <div className="font-sans text-sm font-semibold">Operator mode</div>
                    </div>
                    <div className="mt-2 text-xs leading-5 text-emerald-50/84">
                      CTO chat is treated like a trusted always-on operator surface, not a temporary planner tab. That is why full access is the default starting posture here.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeStep === "project" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-5">
                  <div className={cn(cardCls, "p-5")}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Step 2 · Project memory</div>
                    <div className="mt-2 text-xl font-semibold tracking-[-0.02em] text-fg">
                      Seed the memory this operator should carry forward
                    </div>
                    <div className="mt-2 max-w-3xl text-sm leading-6 text-fg/72">
                      This is the memory the CTO keeps warm across sessions. Think in terms of stable project understanding, conventions the team should not forget, and the work that matters right now.
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      {[
                        { label: "Project summary", detail: "What this repo is, what it uses, and what matters." },
                        { label: "Conventions", detail: "Rules and habits the CTO should keep enforcing." },
                        { label: "Current focus", detail: "The live priorities it should orient around today." },
                      ].map((item) => (
                        <div key={item.label} className="rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/48">{item.label}</div>
                          <div className="mt-2 text-xs leading-5 text-fg/72">{item.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {detection ? (
                    <div className={cn(cardCls, "p-5")}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="font-sans text-sm font-semibold text-fg">Use repository-detected defaults</div>
                          <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                            We scanned the repo to give you a head start. Apply these defaults if they look roughly right, then refine them.
                          </div>
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

                      <div className="mt-4 grid gap-3 md:grid-cols-[1.1fr_1fr]">
                        <div className="rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">Detected project types</div>
                          <div className="mt-2 text-sm text-fg/78">
                            {detection.projectTypes.join(", ") || "No strong project type detected"}
                          </div>
                        </div>
                        <div className="rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">Signals</div>
                          <div className="mt-2 text-xs leading-5 text-fg/68">
                            {detectedSignalsSummary}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className={cn(cardCls, "space-y-4 p-5")}>
                    <div>
                      <div className="font-sans text-sm font-semibold text-fg">Teach the CTO your project</div>
                      <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                        Short, concrete inputs are better than huge essays. Write the stable things you want remembered, then list the current priorities separately.
                      </div>
                    </div>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Project Summary</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[120px]")}
                        rows={5}
                        placeholder="What is this project, who is it for, and what stack does it use?"
                        value={project.projectSummary}
                        onChange={(event) => setProject((draft) => ({ ...draft, projectSummary: event.target.value }))}
                      />
                      <div className="text-[11px] leading-5 text-muted-fg/58">
                        Example: “Desktop app for AI-assisted software execution. Electron + React + TypeScript. CTO and worker flows coordinate coding, review, and Linear routing.”
                      </div>
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Key Conventions</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[92px]")}
                        rows={4}
                        placeholder={"TypeScript strict\nNo force pushes to shared branches\nPrefer one living Linear workpad comment"}
                        value={project.conventions}
                        onChange={(event) => setProject((draft) => ({ ...draft, conventions: event.target.value }))}
                      />
                      <div className="text-[11px] leading-5 text-muted-fg/58">
                        Use commas or new lines. These become long-term team rules the CTO should remember.
                      </div>
                    </label>

                    <label className="space-y-1 block">
                      <div className={labelCls}>Active Focus Areas</div>
                      <textarea
                        className={cn(textareaCls, "min-h-[92px]")}
                        rows={4}
                        placeholder={"single-device CTO polish\nworker continuity\nproof-backed Linear closeout"}
                        value={project.activeFocus}
                        onChange={(event) => setProject((draft) => ({ ...draft, activeFocus: event.target.value }))}
                      />
                      <div className="text-[11px] leading-5 text-muted-fg/58">
                        Use this for current priorities only. It is okay for this section to change often.
                      </div>
                    </label>

                    {scanDone ? (
                      <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/18 bg-emerald-500/[0.08] px-4 py-3 font-mono text-[10px] text-emerald-100">
                        <CheckCircle size={12} weight="bold" />
                        Repo-detected defaults applied.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-4 xl:pt-1">
                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">Memory after setup</div>
                    <div className="mt-4 space-y-3">
                      {[
                        { label: "Summary", value: project.projectSummary.trim() || "No project summary yet." },
                        { label: "Conventions", value: summarizeDraftList(project.conventions, "No conventions yet.") },
                        { label: "Current focus", value: summarizeDraftList(project.activeFocus, "No active focus yet.") },
                      ].map((item) => (
                        <div key={item.label} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
                          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-fg/42">{item.label}</div>
                          <div className="mt-1 text-xs leading-5 text-fg/76">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="flex items-center gap-2 text-fg">
                      <GitBranch size={14} weight="duotone" className="text-cyan-200" />
                      <div className="font-sans text-sm font-semibold">How this gets used</div>
                    </div>
                    <div className="mt-3 space-y-2 text-xs leading-5 text-muted-fg/68">
                      <div>The project summary helps the CTO explain the repo and make better strategic decisions.</div>
                      <div>Conventions are the rules it should keep bringing back into implementation and review.</div>
                      <div>Active focus areas bias the operator toward what matters most right now without overwriting the stable memory.</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeStep === "integrations" && (
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
                <div className="space-y-5">
                  <div className={cn(cardCls, "p-5")}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Step 3 · Integrations</div>
                    <div className="mt-2 text-xl font-semibold tracking-[-0.02em] text-fg">
                      Decide whether to connect Linear right now
                    </div>
                    <div className="mt-2 max-w-3xl text-sm leading-6 text-fg/72">
                      Keep first-run setup simple. The CTO works without Linear. If you connect it now, you unlock issue routing and workflow publishing immediately. If not, you can finish setup and come back later.
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-4">
                        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">Fastest path</div>
                        <div className="mt-2 text-sm font-semibold text-fg">Finish setup without Linear</div>
                        <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                          Best if you just want the persistent CTO live now. You can wire Linear in later from the CTO tab.
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/[0.08] bg-black/15 px-4 py-4">
                        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">If you connect now</div>
                        <div className="mt-2 text-sm font-semibold text-fg">Issue routing starts earlier</div>
                        <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                          You immediately unlock delegated issue workflows, living workpad comments, and proof-backed closeout publishing.
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className={cn(cardCls, "p-5")}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-sans text-sm font-semibold text-fg">Linear connection</div>
                        <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                          Personal API keys are the fastest first-run path. OAuth is still available when you want it.
                        </div>
                      </div>
                      <div className="rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-fg/68">
                        {linearSummary}
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl border border-white/[0.08] bg-black/15 p-4">
                      <LinearConnectionPanel
                        compact
                        onStatusChange={handleLinearStatusChange}
                      />
                    </div>
                  </div>

                  {!linearStatus?.connected ? (
                    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                          <div className="font-sans text-sm font-semibold text-fg">You can finish setup without Linear</div>
                          <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                            The primary button will still complete onboarding. Linear setup stays available from the CTO tab afterward.
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setIntegrationSkipped(true)}
                        >
                          Skip Linear for now
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-4">
                    <div className="font-sans text-sm font-semibold text-fg">External routing can wait</div>
                    <div className="mt-1 text-xs leading-5 text-muted-fg/68">
                      OpenClaw bridge routing and other advanced integration policies do not need to be part of first-run setup. Keep the first launch simple, then extend from CTO settings when the operator is already live.
                    </div>
                  </div>
                </div>

                <div className="space-y-4 xl:pt-1">
                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-fg/45">What Linear unlocks</div>
                    <div className="mt-4 space-y-3">
                      {[
                        "Assignee and workflow-based issue routing",
                        "One living workpad comment per delegated run",
                        "PR / proof links in closeout publishing",
                      ].map((item) => (
                        <div key={item} className="flex items-start gap-2 text-xs leading-5 text-fg/74">
                          <CheckCircle size={13} weight="fill" className="mt-1 text-emerald-300" />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={cn(recessedPanelCls, "p-4")}>
                    <div className="flex items-center gap-2 text-fg">
                      <ArrowSquareOut size={14} weight="duotone" className="text-cyan-200" />
                      <div className="font-sans text-sm font-semibold">After setup</div>
                    </div>
                    <div className="mt-3 space-y-2 text-xs leading-5 text-muted-fg/68">
                      <div>You can reopen this flow from the CTO tab settings any time.</div>
                      <div>You can change the active model later without rebuilding the operator.</div>
                      <div>You can connect Linear later without losing the memory you just created.</div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-cyan-400/18 bg-cyan-500/[0.08] p-4">
                    <div className="flex items-center gap-2 text-cyan-100">
                      <Plugs size={14} weight="duotone" />
                      <div className="font-sans text-sm font-semibold">Current status</div>
                    </div>
                    <div className="mt-2 text-xs leading-5 text-cyan-50/84">
                      {linearStatus?.connected
                        ? `Linear is connected${linearStatus.viewerName ? ` as ${linearStatus.viewerName}` : ""}.`
                        : integrationSkipped
                          ? "You have chosen to keep first-run setup focused and add Linear later."
                          : "Linear is still optional here. You can finish onboarding even if you leave it disconnected."}
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
