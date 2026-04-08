import React, { useCallback, useEffect, useState } from "react";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { ContextRefreshEvents, ContextStatus } from "../../../shared/types";
import { Button } from "../ui/Button";
import { AiFeaturesSection } from "../settings/AiFeaturesSection";
import { GitHubSection } from "../settings/GitHubSection";
import { LinearSection } from "../settings/LinearSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { DevToolsSection } from "./DevToolsSection";
import { EmbeddingsSection } from "./EmbeddingsSection";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { publishOnboardingStatusUpdated } from "../../lib/onboardingStatusEvents";
import { listActionableContextDocs } from "../context/contextShared";

type SetupStep = "tools" | "ai" | "helpers" | "github" | "embeddings" | "linear" | "context";

const STEP_ORDER: SetupStep[] = ["tools", "ai", "helpers", "github", "embeddings", "linear", "context"];

const STEP_META: Record<SetupStep, { title: string; subtitle: string }> = {
  tools: {
    title: "Dev tools",
    subtitle: "Verify git and GitHub CLI are ready",
  },
  ai: {
    title: "AI connections",
    subtitle: "Connect Claude, Codex, Cursor, and OpenCode",
  },
  helpers: {
    title: "Background helpers",
    subtitle: "Optional helpers that run in the background",
  },
  github: {
    title: "GitHub",
    subtitle: "Enable PR and code review workflows",
  },
  embeddings: {
    title: "Semantic search",
    subtitle: "Local vector model for smart memory search",
  },
  linear: {
    title: "Linear",
    subtitle: "Issue tracking and CTO workflow routing",
  },
  context: {
    title: "Context docs",
    subtitle: "Auto-generate PRD and architecture docs",
  },
};

/* Step header — short title on top, subtitle below */
const STEP_HEADERS: Record<SetupStep, { heading: string; sub: string }> = {
  tools: { heading: "Developer Tools", sub: "ADE needs git for version control. GitHub CLI unlocks PR creation, review requests, and CI checks." },
  ai: {
    heading: "Runtime providers",
    sub: "Set up the four ADE runtime providers: Claude, Codex, and Cursor use their native CLIs. OpenCode powers API-backed and local model chats (LM Studio, Ollama). After a CLI is installed and signed in, its models appear automatically.",
  },
  helpers: { heading: "Background helpers", sub: "These lightweight helpers run in the background while you work. They are optional and can be changed anytime in Settings." },
  github: { heading: "GitHub Integration", sub: "A personal access token lets ADE create PRs, request reviews, and monitor CI on your behalf." },
  embeddings: { heading: "Semantic Search", sub: "A small local model that enables meaning-based memory search instead of just keyword matching." },
  linear: { heading: "Linear Integration", sub: "Connect your Linear workspace to route issues, sync statuses, and enable CTO workflows." },
  context: { heading: "Context Documents", sub: "Generate a PRD and architecture overview from your codebase. These help ADE understand your project deeply." },
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

const DEFAULT_EVENTS: ContextRefreshEvents = {};

function isContextGenerationActive(status: ContextStatus["generation"] | null | undefined): boolean {
  return status?.state === "pending" || status?.state === "running";
}

function hasReadyContextDocs(status: ContextStatus | null): boolean {
  const docs = status?.docs;
  return !!docs?.length && docs.every((doc) => doc.health === "ready");
}

function describeContextStatusLine(args: {
  contextLoading: boolean;
  isGenerating: boolean;
  contextStatus: ContextStatus | null;
  contextModelId: string;
}): string {
  if (args.contextLoading) return "Checking status...";
  if (args.isGenerating) {
    return args.contextStatus?.generation.state === "pending"
      ? "Doc generation is queued and will start shortly."
      : "Generating docs — this can take a minute or two depending on your model and repo size.";
  }
  if (args.contextStatus?.generation.state === "failed") {
    const error = args.contextStatus.generation.error;
    return `Last generation failed${error ? `: ${error}` : "."}`;
  }
  if (hasReadyContextDocs(args.contextStatus)) {
    return "Both docs are present. You can regenerate if needed.";
  }
  if (!args.contextModelId.trim()) {
    return "Select a model above to generate docs.";
  }
  const actionable = listActionableContextDocs(args.contextStatus)
    .map((d) => `${d.label} (${d.health})`)
    .join(", ");
  return `Needs generation: ${actionable || "checking..."}`;
}

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);
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
      .catch((error) => {
        console.error("ProjectSetupPage: failed to load onboarding status", error);
        if (!cancelled) setStatus({ completedAt: null, dismissedAt: null });
      });

    // Load available models
    window.ade.ai.getStatus()
      .then((aiStatus) => {
        if (!cancelled) setAvailableModelIds(deriveConfiguredModelIds(aiStatus));
      })
      .catch((error) => {
        console.error("ProjectSetupPage: failed to load AI status", error);
      });

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
      .catch((error) => {
        console.error("ProjectSetupPage: failed to load context doc prefs", error);
        setPrefsLoaded(true);
      });

    return () => { cancelled = true; };
  }, []);

  const reloadContextStatus = React.useCallback(async () => {
    setContextLoading(true);
    try {
      const next = await window.ade.context.getStatus();
      setContextStatus(next);
    } catch (error) {
      console.error("ProjectSetupPage: failed to refresh context status", error);
      setContextStatus(null);
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step !== "context") return;
    void reloadContextStatus();
  }, [reloadContextStatus, step]);

  useEffect(() => {
    return window.ade.context?.onStatusChanged?.(setContextStatus) ?? (() => {});
  }, []);

  const handleNext = async () => {
    if (isLastStep) {
      setBusy(true);
      try {
        const next = await window.ade.onboarding.complete();
        setStatus(next);
        publishOnboardingStatusUpdated(next);
        navigate("/work", { replace: true });
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
      navigate("/work", { replace: true });
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
        provider: "opencode",
        modelId: contextModelId,
        reasoningEffort: contextReasoningEffort,
        events: contextEvents,
      });

      // Fire and forget generation
      void window.ade.context.generateDocs({
        provider: "opencode",
        modelId: contextModelId,
        reasoningEffort: contextReasoningEffort,
        events: contextEvents,
      }).catch((error) => {
        console.error("ProjectSetupPage: failed to launch context docs generation", error);
      });

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
        provider: "opencode",
        modelId: contextModelId,
        reasoningEffort: contextReasoningEffort,
        events: contextEvents,
      })?.catch((error) => {
        console.error("ProjectSetupPage: failed to auto-save context doc prefs", error);
      });
    }, 400);
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [prefsLoaded, contextModelId, contextReasoningEffort, contextEvents]);

  const isGenerating = isContextGenerationActive(contextStatus?.generation);

  const stepContent = (() => {
    if (step === "tools") return <DevToolsSection onStatusChange={setGitInstalled} />;
    if (step === "ai") return <ProvidersSection forceRefreshOnMount />;
    if (step === "helpers") return <AiFeaturesSection />;
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
          <ProviderModelSelector
            value={contextModelId}
            onChange={setContextModelId}
            availableModelIds={availableModelIds}
            showReasoning
            reasoningEffort={contextReasoningEffort}
            onReasoningEffortChange={setContextReasoningEffort}
            onOpenAiSettings={openAiProvidersSettings}
            className="w-full"
          />
          {/* Status */}
          <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px" }}>
            {describeContextStatusLine({ contextLoading, isGenerating, contextStatus, contextModelId })}
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
            background: "rgba(18, 17, 24, 0.88)",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 16,
            backdropFilter: "blur(20px)",
            overflow: "hidden",
          }}
        >
          {/* Gradient accent bar */}
          <div
            style={{
              height: 3,
              background: `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.accent}60, transparent)`,
            }}
          />

          <div style={{ padding: 20 }}>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, fontWeight: 700, color: COLORS.accent, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              Setup
            </div>
            <div style={{ marginTop: 10, fontSize: 20, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              {project?.displayName ?? "Current project"}
            </div>
            <div style={{ marginTop: 8, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              Get ADE configured for your project. You can always change these in Settings later.
            </div>

            {/* Progress indicator */}
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: COLORS.border, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${((stepIndex + 1) / STEP_ORDER.length) * 100}%`,
                    borderRadius: 2,
                    background: `linear-gradient(90deg, ${COLORS.accent}, ${COLORS.accent}CC)`,
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textMuted, whiteSpace: "nowrap" }}>
                {stepIndex + 1} of {STEP_ORDER.length}
              </div>
            </div>

            {/* Step list with vertical connecting line */}
            <div style={{ marginTop: 20, position: "relative" }}>
              {/* Vertical connecting line */}
              <div
                style={{
                  position: "absolute",
                  left: 19,
                  top: 24,
                  bottom: 24,
                  width: 1,
                  background: COLORS.border,
                  zIndex: 0,
                }}
              />

              <div style={{ display: "grid", gap: 4, position: "relative", zIndex: 1 }}>
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
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: `1px solid ${active ? `${COLORS.accent}30` : "transparent"}`,
                        background: active ? `${COLORS.accent}10` : "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "all 0.15s ease",
                        ...(active ? { boxShadow: `0 0 12px ${COLORS.accent}15` } : {}),
                      }}
                    >
                      <div style={{ flexShrink: 0, marginTop: 2, position: "relative" }}>
                        {complete ? (
                          <CheckCircle size={18} color={COLORS.success} weight="fill" />
                        ) : (
                          <Circle
                            size={18}
                            color={active ? COLORS.accent : COLORS.textDim}
                            weight={active ? "fill" : "regular"}
                            style={active ? { filter: `drop-shadow(0 0 4px ${COLORS.accent}60)` } : {}}
                          />
                        )}
                      </div>
                      <span>
                        <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: active ? COLORS.textPrimary : COLORS.textMuted }}>
                          {STEP_META[stepId].title}
                        </div>
                        <div style={{ marginTop: 2, fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>
                          {STEP_META[stepId].subtitle}
                        </div>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
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
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                height: 2,
                borderRadius: 1,
                background: `linear-gradient(90deg, ${COLORS.accent}80, ${COLORS.accent}20, transparent)`,
                marginBottom: 16,
              }}
            />
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              {header.heading}
            </div>
            <div style={{ marginTop: 4, fontSize: 13, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              {header.sub}
            </div>
          </div>

          {/* Step content */}
          <div style={{ minWidth: 0 }}>{stepContent}</div>

          {/* Footer */}
          <div style={{ marginTop: 24, display: "flex", alignItems: "center", gap: 12 }}>
            <Button size="md" variant="ghost" disabled={busy} onClick={() => void handleSkip()}>
              Skip setup
            </Button>
            <Button size="md" variant="outline" disabled={busy || stepIndex === 0} onClick={handleBack}>
              Back
            </Button>
            <div style={{ flex: 1 }} />
            <Button
              size="md"
              variant="primary"
              disabled={busy || (step === "tools" && gitInstalled !== true) || (isLastStep && gitInstalled !== true)}
              onClick={() => void handleNext()}
            >
              {busy ? "Saving..." : isLastStep ? "Finish setup" : "Continue"}
            </Button>
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
