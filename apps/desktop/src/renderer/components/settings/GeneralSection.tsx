import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  COLORS,
  MONO_FONT,
  cardStyle,
  LABEL_STYLE,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { AdeCliSection } from "./AdeCliSection";
import { AboutSection } from "./AboutSection";
import { ProjectSection } from "./ProjectSection";
import { DictationSection } from "./DictationSection";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

export function GeneralSection() {
  const navigate = useNavigate();
  const [onboardingStatus, setOnboardingStatus] = useState<{ completedAt: string | null; dismissedAt: string | null; freshProject?: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.ade.onboarding
      .getStatus()
      .then((value) => {
        if (!cancelled) setOnboardingStatus(value);
      })
      .catch(() => {
        if (!cancelled) setOnboardingStatus({ completedAt: null, dismissedAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setupComplete = Boolean(onboardingStatus?.completedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={sectionLabelStyle}>PROJECT SETUP</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>
                {setupComplete ? "Project setup completed" : onboardingStatus?.freshProject ? "Fresh project setup available" : "Project setup can be reopened"}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
                The guided setup flow covers AI, GitHub, Linear, and local helpers for fresh projects. You can reopen it any time if you want to walk through those steps again.
              </div>
            </div>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "4px 8px",
                fontSize: 10,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                textTransform: "uppercase",
                letterSpacing: "1px",
                color: setupComplete ? COLORS.success : onboardingStatus?.freshProject ? COLORS.warning : COLORS.textMuted,
                background: setupComplete ? "color-mix(in srgb, var(--color-success) 18%, transparent)" : onboardingStatus?.freshProject ? "color-mix(in srgb, var(--color-warning) 18%, transparent)" : "color-mix(in srgb, var(--color-muted-fg) 18%, transparent)",
                border: setupComplete
                  ? "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)"
                  : onboardingStatus?.freshProject
                    ? "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)"
                    : "1px solid color-mix(in srgb, var(--color-muted-fg) 30%, transparent)",
              }}
            >
              {setupComplete ? "Ready" : onboardingStatus?.freshProject ? "Fresh project" : "Available"}
            </span>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={primaryButton()} onClick={() => navigate("/onboarding")}>
              {setupComplete ? "RUN SETUP AGAIN" : "OPEN PROJECT SETUP"}
            </button>
          </div>
        </div>
      </section>

      <ProjectSection />

      <DictationSection />

      <section>
        <div style={sectionLabelStyle}>ADE CLI</div>
        <AdeCliSection compact />
      </section>

      <section>
        <div style={sectionLabelStyle}>ABOUT</div>
        <AboutSection />
      </section>
    </div>
  );
}
