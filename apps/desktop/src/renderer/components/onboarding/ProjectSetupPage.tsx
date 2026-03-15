import React, { useEffect, useMemo, useState } from "react";
import { CheckCircle, Circle, GithubLogo, Plugs, RocketLaunch } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { ContextStatus } from "../../../shared/types";
import { Button } from "../ui/Button";
import { AiSettingsSection } from "../settings/AiSettingsSection";
import { GitHubSection } from "../settings/GitHubSection";
import { LinearSection } from "../settings/LinearSection";
import { useAppStore } from "../../state/appStore";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { publishOnboardingStatusUpdated } from "../../lib/onboardingStatusEvents";

type SetupStep = "ai" | "github" | "linear" | "context";

const STEP_ORDER: SetupStep[] = ["ai", "github", "linear", "context"];

const STEP_META: Record<SetupStep, { title: string; description: string }> = {
  ai: {
    title: "AI setup",
    description: "Connect a provider and choose the defaults you want ADE to use on day one.",
  },
  github: {
    title: "GitHub",
    description: "Add a token so lane PRs, reviews, and repository actions can work immediately.",
  },
  linear: {
    title: "Linear",
    description: "Optional. Connect Linear now if you want issue links and later CTO routing.",
  },
  context: {
    title: "Context docs",
    description: "Kick off context doc generation so ADE can build project memory and better first-session context.",
  },
};

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const [step, setStep] = useState<SetupStep>("ai");
  const [status, setStatus] = useState<{ completedAt: string | null; dismissedAt: string | null; freshProject?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLaunchNotice, setContextLaunchNotice] = useState<string | null>(null);
  const [contextLaunchError, setContextLaunchError] = useState<string | null>(null);

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
    return () => {
      cancelled = true;
    };
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
      const prefs = await window.ade.context.getPrefs();
      void window.ade.context.generateDocs({
        provider: prefs.provider ?? "unified",
        modelId: prefs.modelId ?? undefined,
        reasoningEffort: prefs.reasoningEffort ?? null,
        events: prefs.events,
      }).catch(() => {});
      setContextLaunchNotice("Context doc generation started. ADE will keep running it in the background while you finish setup.");
      window.setTimeout(() => {
        void reloadContextStatus();
      }, 500);
    } catch (error) {
      setContextLaunchError(error instanceof Error ? error.message : String(error));
    }
  };

  const stepContent = (() => {
    if (step === "ai") return <AiSettingsSection forceProviderRefreshOnMount />;
    if (step === "github") return <GitHubSection />;
    if (step === "linear") return <LinearSection />;
    return (
      <div style={{ display: "grid", gap: 18 }}>
        <div
          style={{
            padding: 18,
            background: COLORS.cardBg,
            border: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <RocketLaunch size={18} color={COLORS.accent} />
            <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.textPrimary }}>
              Finish by kicking off context docs
            </div>
          </div>
          <div style={{ fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.7 }}>
            Context docs improve first-message context, memory ingestion, and project-level summaries. You can launch generation now and ADE will continue it while you start working.
          </div>
        </div>

        <div
          style={{
            padding: 18,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.border}`,
            display: "grid",
            gap: 10,
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
          }}
        >
          <div>
            {contextLoading
              ? "Checking context doc status..."
              : contextStatus?.generation.state === "running"
                ? "Context doc generation is already running."
                : contextStatus?.generation.state === "failed"
                  ? `Last generation failed${contextStatus.generation.error ? `: ${contextStatus.generation.error}` : "."}`
                  : `Missing docs: ${(contextStatus?.docs?.filter((doc) => !doc.exists).map((doc) => doc.label).join(", ") || "none")}.`}
          </div>
          <div>Once generation is launched, you can finish setup immediately and let ADE handle the rest in the background.</div>
          <div>Settings later lets you change the model, triggers, or rerun generation manually.</div>
        </div>

        {contextLaunchNotice ? (
          <div style={{
            padding: "10px 12px",
            border: `1px solid ${COLORS.success}30`,
            background: `${COLORS.success}12`,
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.success,
          }}>
            {contextLaunchNotice}
          </div>
        ) : null}

        {contextLaunchError ? (
          <div style={{
            padding: "10px 12px",
            border: `1px solid ${COLORS.danger}30`,
            background: `${COLORS.danger}12`,
            fontSize: 11,
            fontFamily: MONO_FONT,
            color: COLORS.danger,
          }}>
            {contextLaunchError}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Button size="md" variant="outline" onClick={() => void reloadContextStatus()}>
            Refresh status
          </Button>
          <Button size="md" variant="primary" onClick={() => void handleLaunchContextGeneration()}>
            {contextStatus?.generation.state === "running" ? "Restart generation" : "Start generation in background"}
          </Button>
        </div>
      </div>
    );
  })();

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
        <aside
          style={{
            alignSelf: "start",
            position: "sticky",
            top: 0,
            padding: 20,
            background: "rgba(18, 17, 24, 0.88)",
            border: `1px solid ${COLORS.border}`,
            backdropFilter: "blur(20px)",
          }}
        >
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.accent, letterSpacing: "1px", textTransform: "uppercase" }}>
            Project setup
          </div>
          <div style={{ marginTop: 10, fontSize: 22, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            {project?.displayName ?? "Current project"}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.7 }}>
            A guided pass through the settings new contributors usually need before the app is useful.
          </div>
          <div
            style={{
              marginTop: 18,
              display: "inline-flex",
              alignItems: "center",
              padding: "4px 8px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              letterSpacing: "1px",
              textTransform: "uppercase",
              color: COLORS.textMuted,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            Step {progressLabel}
          </div>

          <div style={{ marginTop: 22, display: "grid", gap: 10 }}>
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
                    border: `1px solid ${active ? COLORS.accent : COLORS.border}`,
                    background: active ? `${COLORS.accent}10` : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  {complete ? (
                    <CheckCircle size={16} color={COLORS.success} weight="fill" style={{ flexShrink: 0, marginTop: 2 }} />
                  ) : (
                    <Circle size={16} color={active ? COLORS.accent : COLORS.textDim} weight={active ? "fill" : "regular"} style={{ flexShrink: 0, marginTop: 2 }} />
                  )}
                  <span>
                    <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: active ? COLORS.textPrimary : COLORS.textMuted, textTransform: "uppercase", letterSpacing: "1px" }}>
                      {STEP_META[stepId].title}
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, lineHeight: 1.6 }}>
                      {STEP_META[stepId].description}
                    </div>
                  </span>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 18, display: "flex", gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => navigate("/settings?tab=general")}>
              General
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate("/project")}>
              Back to app
            </Button>
          </div>
        </aside>

        <section
          style={{
            minWidth: 0,
            padding: 22,
            background: "rgba(18, 17, 24, 0.9)",
            border: `1px solid ${COLORS.border}`,
            backdropFilter: "blur(22px)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "1px" }}>
                {STEP_META[step].title}
              </div>
              <div style={{ marginTop: 8, fontSize: 24, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                {STEP_META[step].description}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void handleSkip()}>
                Skip setup
              </Button>
            </div>
          </div>

          <div style={{ marginBottom: 20, display: "flex", flexWrap: "wrap", gap: 8 }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                letterSpacing: "1px",
                textTransform: "uppercase",
                color: COLORS.info,
                border: `1px solid ${COLORS.info}30`,
                background: `${COLORS.info}12`,
              }}
            >
              <Plugs size={12} />
              AI and integrations first
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 8px",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                letterSpacing: "1px",
                textTransform: "uppercase",
                color: COLORS.textMuted,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              <GithubLogo size={12} />
              PRs work after GitHub is connected
            </span>
          </div>

          <div style={{ minWidth: 0 }}>{stepContent}</div>

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
              <Button size="md" variant="primary" disabled={busy} onClick={() => void handleNext()}>
                {busy ? "Saving..." : isLastStep ? "Finish setup" : "Continue"}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
