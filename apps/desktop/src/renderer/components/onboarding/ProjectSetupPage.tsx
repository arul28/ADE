import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { ContextRefreshEvents, ContextStatus } from "../../../shared/types";
import { Button } from "../ui/Button";
import { AiSettingsSection } from "../settings/AiSettingsSection";
import { GitHubSection } from "../settings/GitHubSection";
import { LinearSection } from "../settings/LinearSection";
import { DevToolsSection } from "./DevToolsSection";
import { EmbeddingsSection } from "./EmbeddingsSection";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { publishOnboardingStatusUpdated } from "../../lib/onboardingStatusEvents";

type SetupStep = "tools" | "ai" | "github" | "embeddings" | "linear" | "context";

const STEP_ORDER: SetupStep[] = ["tools", "ai", "github", "embeddings", "linear", "context"];

const STEP_META: Record<SetupStep, { title: string; subtitle: string }> = {
  tools: {
    title: "Dev tools",
    subtitle: "Check for git and GitHub CLI.",
  },
  ai: {
    title: "AI setup",
    subtitle: "Connect a provider and choose defaults.",
  },
  github: {
    title: "GitHub",
    subtitle: "Add a token for PRs, reviews, and repo actions.",
  },
  embeddings: {
    title: "Smart search",
    subtitle: "Optional local embedding model for semantic memory search.",
  },
  linear: {
    title: "Linear",
    subtitle: "Optional. Connect for issue links and CTO routing.",
  },
  context: {
    title: "Context docs",
    subtitle: "Generate PRD and architecture docs from your repo.",
  },
};

/* Step header — short title on top, subtitle below */
const STEP_HEADERS: Record<SetupStep, { heading: string; sub: string }> = {
  tools: { heading: "Dev tools check", sub: "ADE needs git installed. GitHub CLI is recommended for PR workflows." },
  ai: { heading: "Connect AI", sub: "Choose a provider and model defaults for this project." },
  github: { heading: "Connect GitHub", sub: "Add a personal access token (classic or fine-grained) so lane PRs and reviews work." },
  embeddings: { heading: "Local embedding model", sub: "Download all-MiniLM-L6-v2 (~31 MB) to enable semantic memory search. Runs entirely on your machine." },
  linear: { heading: "Connect Linear", sub: "Optional — connect for issue routing and CTO workflows." },
  context: { heading: "Generate context docs", sub: "Pick a model and triggers, then kick off generation." },
};

const EVENT_TOGGLES: { key: keyof ContextRefreshEvents; label: string; help: string }[] = [
  { key: "onSessionEnd", label: "Session end", help: "When a terminal/agent session ends" },
  { key: "onCommit", label: "Commit", help: "When a commit is created" },
  { key: "onPrCreate", label: "PR create", help: "When a PR is created or updated" },
  { key: "onPrLand", label: "PR land", help: "When a PR is merged" },
  { key: "onMissionStart", label: "Mission start", help: "When a mission launches" },
  { key: "onMissionEnd", label: "Mission end", help: "When a mission completes" },
  { key: "onLaneCreate", label: "Lane create", help: "When a new lane is created" },
];

const DEFAULT_EVENTS: ContextRefreshEvents = { onPrCreate: true, onMissionStart: true };

function isContextGenerationActive(status: ContextStatus["generation"] | null | undefined): boolean {
  return status?.state === "pending" || status?.state === "running";
}

function hasReadyContextDocs(status: ContextStatus | null): boolean {
  return status?.docs?.every((doc) => doc.exists && doc.sizeBytes >= 200) ?? false;
}

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const [step, setStep] = useState<SetupStep>("tools");
  const [status, setStatus] = useState<{ completedAt: string | null; dismissedAt: string | null; freshProject?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);

  // Context docs state
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLaunchNotice, setContextLaunchNotice] = useState<string | null>(null);
  const [contextLaunchError, setContextLaunchError] = useState<string | null>(null);

  // Context doc generation config (same as settings ContextSection)
  const [contextModelId, setContextModelId] = useState("");
  const [contextReasoningEffort, setContextReasoningEffort] = useState<string | null>(null);
  const [contextEvents, setContextEvents] = useState<ContextRefreshEvents>({ ...DEFAULT_EVENTS });
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [prefsLoaded, setPrefsLoaded] = useState(false);

  const stepIndex = STEP_ORDER.indexOf(step);
  const isLastStep = stepIndex === STEP_ORDER.length - 1;

  useEffect(() => {
    let cancelled = false;
    window.ade.onboarding
      .getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus({ completedAt: null, dismissedAt: null });
      });

    // Load available models
    window.ade.ai.getStatus()
      .then((aiStatus) => {
        if (!cancelled) setAvailableModelIds(deriveConfiguredModelIds(aiStatus));
      })
      .catch(() => {});

    // Load saved context doc prefs
    window.ade.context?.getPrefs?.()
      .then((prefs) => {
        if (cancelled) return;
        if (prefs.modelId) setContextModelId(prefs.modelId);
        if (prefs.reasoningEffort) setContextReasoningEffort(prefs.reasoningEffort);
        if (prefs.events) {
          const hasAny = Object.values(prefs.events).some(Boolean);
          if (hasAny) setContextEvents(prefs.events);
        }
        setPrefsLoaded(true);
      })
      .catch(() => { setPrefsLoaded(true); });

    return () => { cancelled = true; };
  }, []);

  const reloadContextStatus = React.useCallback(async () => {
    setContextLoading(true);
    try {
      const next = await window.ade.context.getStatus();
      setContextStatus(next);
    } catch {
      setContextStatus(null);
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step !== "context") return;
    void reloadContextStatus();
  }, [reloadContextStatus, step]);

  // Poll while generating
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (isContextGenerationActive(contextStatus?.generation) && !pollRef.current) {
      pollRef.current = setInterval(() => { void reloadContextStatus(); }, 2500);
    }
    if (!isContextGenerationActive(contextStatus?.generation) && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [contextStatus?.generation, reloadContextStatus]);

  const progressLabel = useMemo(() => `${stepIndex + 1} / ${STEP_ORDER.length}`, [stepIndex]);

  const handleNext = async () => {
    if (isLastStep) {
      setBusy(true);
      try {
        const next = await window.ade.onboarding.complete();
        setStatus(next);
        publishOnboardingStatusUpdated(next);
        navigate("/project", { replace: true });
      } finally {
        setBusy(false);
      }
      return;
    }
    setStep(STEP_ORDER[stepIndex + 1] ?? "context");
  };

  const handleBack = () => {
    const prev = STEP_ORDER[stepIndex - 1];
    if (prev) setStep(prev);
  };

  const handleSkip = async () => {
    setBusy(true);
    try {
      const next = await window.ade.onboarding.setDismissed(true);
      setStatus(next);
      publishOnboardingStatusUpdated(next);
      navigate("/project", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const handleLaunchContextGeneration = async () => {
    setContextLaunchError(null);
    setContextLaunchNotice(null);
    try {
      // Save prefs first (same flow as settings)
      await window.ade.context.savePrefs({
        provider: "unified",
        modelId: contextModelId,
        reasoningEffort: contextReasoningEffort,
        events: contextEvents,
      });

      // Fire and forget generation
      void window.ade.context.generateDocs({
        provider: "unified",
        modelId: contextModelId,
        reasoningEffort: contextReasoningEffort,
        events: contextEvents,
      }).catch(() => {});

      setContextLaunchNotice("Generation started in the background. You can finish setup now.");
      window.setTimeout(() => { void reloadContextStatus(); }, 800);
    } catch (error) {
      setContextLaunchError(error instanceof Error ? error.message : String(error));
    }
  };

  // Auto-save prefs when config changes (after initial load)
  const saveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!prefsLoaded) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void window.ade.context?.savePrefs?.({
        provider: "unified",
        modelId: contextModelId,
        reasoningEffort: contextReasoningEffort,
        events: contextEvents,
      }).catch(() => {});
    }, 400);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [prefsLoaded, contextModelId, contextReasoningEffort, contextEvents]);

  const isGenerating = isContextGenerationActive(contextStatus?.generation);

  const stepContent = (() => {
    if (step === "tools") return <DevToolsSection onStatusChange={setGitInstalled} />;
    if (step === "ai") return <AiSettingsSection forceProviderRefreshOnMount />;
    if (step === "github") return <GitHubSection />;
    if (step === "embeddings") return <EmbeddingsSection />;
    if (step === "linear") return <LinearSection />;
    const canGenerate = contextModelId.trim().length > 0 && !isGenerating;

    return (
      <div style={{ display: "grid", gap: 20 }}>
        {/* Model + Generate — grouped together */}
        <div style={cardBox()}>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 4 }}>
            Model
          </div>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, marginBottom: 12, lineHeight: "18px" }}>
            Select the model that will generate your PRD and Architecture docs.
          </div>
          <UnifiedModelSelector
            value={contextModelId}
            onChange={setContextModelId}
            availableModelIds={availableModelIds}
            showReasoning
            reasoningEffort={contextReasoningEffort}
            onReasoningEffortChange={setContextReasoningEffort}
            className="w-full"
          />

          {/* Status */}
          <div style={{ marginTop: 16, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px" }}>
            {contextLoading
              ? "Checking status..."
              : isGenerating
                ? "Generating docs — this can take a minute or two depending on your model and repo size."
                : contextStatus?.generation.state === "failed"
                  ? `Last generation failed${contextStatus.generation.error ? `: ${contextStatus.generation.error}` : "."}`
                  : hasReadyContextDocs(contextStatus)
                    ? "Both docs are present. You can regenerate if needed."
                    : !contextModelId.trim()
                      ? "Select a model above to generate docs."
                      : `Missing or incomplete: ${contextStatus?.docs?.filter((d) => !d.exists || d.sizeBytes < 200).map((d) => d.label).join(", ") || "checking..."}`}
          </div>

          {isGenerating ? (
            <div style={{ ...statusBox(COLORS.info), marginTop: 10 }}>
              Generating in the background — you can continue setup or finish now.
            </div>
          ) : null}

          {contextLaunchNotice && !isGenerating ? (
            <div style={{ ...statusBox(COLORS.success), marginTop: 10 }}>{contextLaunchNotice}</div>
          ) : null}

          {contextLaunchError ? (
            <div style={{ ...statusBox(COLORS.danger), marginTop: 10 }}>{contextLaunchError}</div>
          ) : null}

          {/* Generate + refresh buttons */}
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <Button size="md" variant="primary" onClick={() => void handleLaunchContextGeneration()} disabled={!canGenerate}>
              {isGenerating ? "Generating..." : "Generate now"}
            </Button>
            <Button size="md" variant="outline" onClick={() => void reloadContextStatus()}>
              Refresh status
            </Button>
          </div>
        </div>

        {/* Auto-refresh events — secondary config */}
        <div style={cardBox()}>
          <div style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary, marginBottom: 4 }}>
            Auto-refresh triggers
          </div>
          <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, marginBottom: 12, lineHeight: "18px" }}>
            Choose when docs regenerate automatically. Editable later in Settings.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {EVENT_TOGGLES.map((toggle) => {
              const checked = !!contextEvents[toggle.key];
              return (
                <label
                  key={toggle.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    borderRadius: 10,
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    border: `1px solid ${checked ? `${COLORS.accent}30` : COLORS.border}`,
                    background: checked ? `${COLORS.accent}08` : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setContextEvents((prev) => ({ ...prev, [toggle.key]: !prev[toggle.key] }))}
                    style={{ accentColor: COLORS.accent }}
                  />
                  <div>
                    <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{toggle.label}</div>
                    <div style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>{toggle.help}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    );
  })();

  const header = STEP_HEADERS[step];

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: `linear-gradient(180deg, ${COLORS.pageBg} 0%, #14131a 100%)`,
        padding: 28,
      }}
    >
      <div
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          minHeight: "100%",
          display: "grid",
          gridTemplateColumns: "260px minmax(0, 1fr)",
          gap: 20,
        }}
      >
        {/* ── Sidebar ── */}
        <aside
          style={{
            alignSelf: "start",
            position: "sticky",
            top: 0,
            padding: 20,
            background: "rgba(18, 17, 24, 0.88)",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 16,
            backdropFilter: "blur(20px)",
          }}
        >
          <div style={{ fontSize: 10, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.accent, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Project setup
          </div>
          <div style={{ marginTop: 10, fontSize: 20, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            {project?.displayName ?? "Current project"}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
            Quick setup for the essentials. Everything here is editable later in Settings.
          </div>
          <div
            style={{
              marginTop: 16,
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 10px",
              fontSize: 10,
              fontWeight: 600,
              fontFamily: SANS_FONT,
              letterSpacing: "0.04em",
              color: COLORS.textMuted,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
            }}
          >
            Step {progressLabel}
          </div>

          <div style={{ marginTop: 20, display: "grid", gap: 6 }}>
            {STEP_ORDER.map((stepId, index) => {
              const active = stepId === step;
              const complete = index < stepIndex || (stepId === "context" && Boolean(status?.completedAt));
              return (
                <button
                  key={stepId}
                  type="button"
                  onClick={() => setStep(stepId)}
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "flex-start",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: `1px solid ${active ? `${COLORS.accent}30` : COLORS.border}`,
                    background: active ? `${COLORS.accent}10` : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.15s ease",
                  }}
                >
                  {complete ? (
                    <CheckCircle size={16} color={COLORS.success} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
                  ) : (
                    <Circle size={16} color={active ? COLORS.accent : COLORS.textDim} weight={active ? "fill" : "regular"} style={{ flexShrink: 0, marginTop: 2 }} />
                  )}
                  <span>
                    <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: active ? COLORS.textPrimary : COLORS.textMuted }}>
                      {STEP_META[stepId].title}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>
                      {STEP_META[stepId].subtitle}
                    </div>
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => navigate("/settings?tab=general")}>
              Settings
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate("/project")}>
              Back to app
            </Button>
          </div>
        </aside>

        {/* ── Main content ── */}
        <section
          style={{
            minWidth: 0,
            padding: 24,
            background: "rgba(18, 17, 24, 0.9)",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 16,
            backdropFilter: "blur(22px)",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 24 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                {header.heading}
              </div>
              <div style={{ marginTop: 4, fontSize: 13, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                {header.sub}
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleSkip()}>
              Skip setup
            </Button>
          </div>

          {/* Step content */}
          <div style={{ minWidth: 0 }}>{stepContent}</div>

          {/* Footer */}
          <div style={{ marginTop: 24, display: "flex", justifyContent: "space-between", gap: 12 }}>
            <Button size="md" variant="outline" disabled={busy || stepIndex === 0} onClick={handleBack}>
              Back
            </Button>
            <div style={{ display: "flex", gap: 10 }}>
              {!isLastStep ? (
                <Button size="md" variant="outline" disabled={busy} onClick={() => setStep("context")}>
                  Skip ahead
                </Button>
              ) : null}
              <Button
                size="md"
                variant="primary"
                disabled={busy || (step === "tools" && gitInstalled !== true) || (isLastStep && gitInstalled === false)}
                onClick={() => void handleNext()}
              >
                {busy ? "Saving..." : isLastStep ? "Finish setup" : "Continue"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── Helpers ── */

function cardBox(): React.CSSProperties {
  return {
    padding: 18,
    background: COLORS.cardBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 14,
  };
}

function statusBox(color: string): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 10,
    border: `1px solid ${color}20`,
    background: `${color}08`,
    fontSize: 11,
    fontFamily: SANS_FONT,
    color,
    lineHeight: "18px",
    marginBottom: 4,
  };
}
