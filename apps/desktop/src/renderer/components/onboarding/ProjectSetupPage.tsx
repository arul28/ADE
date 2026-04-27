import React, { useState } from "react";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { AiFeaturesSection } from "../settings/AiFeaturesSection";
import { GitHubSection } from "../settings/GitHubSection";
import { LinearSection } from "../settings/LinearSection";
import { ProvidersSection } from "../settings/ProvidersSection";
import { DevToolsSection } from "./DevToolsSection";
import { EmbeddingsSection } from "./EmbeddingsSection";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { publishOnboardingStatusUpdated } from "../../lib/onboardingStatusEvents";

type SetupStep = "tools" | "ai" | "helpers" | "github" | "embeddings" | "linear";

const STEP_ORDER: SetupStep[] = ["tools", "ai", "helpers", "github", "embeddings", "linear"];

const STEP_META: Record<SetupStep, { title: string; subtitle: string }> = {
  tools: {
    title: "Dev tools",
    subtitle: "Verify git and the ADE command are ready",
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
};

/* Step header — short title on top, subtitle below */
const STEP_HEADERS: Record<SetupStep, { heading: string; sub: string }> = {
  tools: { heading: "Developer tools", sub: "ADE needs git for version control. The bundled ade command is added to agent sessions; installing it here also makes it available in your Terminal." },
  ai: {
    heading: "Runtime providers",
    sub: "Set up the four ADE runtime providers: Claude, Codex, and Cursor use their native CLIs. OpenCode powers API-backed and local model chats (LM Studio, Ollama). After a CLI is installed and signed in, its models appear automatically.",
  },
  helpers: { heading: "Background helpers", sub: "These lightweight helpers run in the background while you work. They are optional and can be changed anytime in Settings." },
  github: { heading: "GitHub Integration", sub: "A personal access token lets ADE create PRs, request reviews, and monitor CI on your behalf." },
  embeddings: { heading: "Semantic Search", sub: "A small local model that enables meaning-based memory search instead of just keyword matching." },
  linear: { heading: "Linear Integration", sub: "Connect your Linear workspace to route issues, sync statuses, and enable CTO workflows." },
};

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const [step, setStep] = useState<SetupStep>("tools");
  const [busy, setBusy] = useState(false);
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);

  const stepIndex = STEP_ORDER.indexOf(step);
  const isLastStep = stepIndex === STEP_ORDER.length - 1;

  const handleNext = async () => {
    if (isLastStep) {
      setBusy(true);
      try {
        const next = await window.ade.onboarding.complete();
        publishOnboardingStatusUpdated(next);
        navigate("/work", { replace: true });
      } finally {
        setBusy(false);
      }
      return;
    }
    const nextStep = STEP_ORDER[stepIndex + 1];
    if (nextStep) setStep(nextStep);
  };

  const handleBack = () => {
    const prev = STEP_ORDER[stepIndex - 1];
    if (prev) setStep(prev);
  };

  const handleSkip = async () => {
    setBusy(true);
    try {
      const next = await window.ade.onboarding.setDismissed(true);
      publishOnboardingStatusUpdated(next);
      navigate("/work", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const stepContent = (() => {
    if (step === "tools") return <DevToolsSection onStatusChange={setGitInstalled} />;
    if (step === "ai") return <ProvidersSection forceRefreshOnMount />;
    if (step === "helpers") return <AiFeaturesSection />;
    if (step === "github") return <GitHubSection />;
    if (step === "embeddings") return <EmbeddingsSection />;
    if (step === "linear") return <LinearSection />;
    return null;
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
                  const complete = index < stepIndex;
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
