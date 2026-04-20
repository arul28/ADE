import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { AppInfo } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";
import { Info } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  cardStyle,
  LABEL_STYLE,
  primaryButton,
} from "../lanes/laneDesignTokens";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

export function GeneralSection() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<{ completedAt: string | null; dismissedAt: string | null; freshProject?: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const providerMode = useAppStore((s) => s.providerMode);

  useEffect(() => {
    let cancelled = false;
    window.ade.app
      .getInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
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

  if (loadError) {
    return <EmptyState title="General" description={`Failed to load: ${loadError}`} />;
  }

  if (!info) {
    return <EmptyState title="General" description="Loading..." />;
  }

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
                The guided setup flow covers AI, GitHub, Linear, and context docs for fresh projects. You can reopen it any time if you want to walk through those steps again.
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
                background: setupComplete ? `${COLORS.success}18` : onboardingStatus?.freshProject ? `${COLORS.warning}18` : `${COLORS.textDim}18`,
                border: setupComplete
                  ? `1px solid ${COLORS.success}30`
                  : onboardingStatus?.freshProject
                    ? `1px solid ${COLORS.warning}30`
                    : `1px solid ${COLORS.textDim}30`,
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

      <section>
        <div style={sectionLabelStyle}>AI MODE</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 0 }}>CURRENT MODE</div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "2px 8px",
              fontSize: 10,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: providerMode === "subscription" ? COLORS.success : COLORS.textMuted,
              background: providerMode === "subscription" ? `${COLORS.success}18` : `${COLORS.textDim}18`,
              border:
                providerMode === "subscription"
                  ? `1px solid ${COLORS.success}30`
                  : `1px solid ${COLORS.textDim}30`,
            }}
          >
            {providerMode}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "10px 12px",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <Info size={15} color={COLORS.textMuted} style={{ flexShrink: 0, marginTop: 1 }} />
            <span
              style={{
                fontSize: 11,
                lineHeight: 1.5,
                fontFamily: MONO_FONT,
                color: COLORS.textMuted,
              }}
            >
              Provider authentication, connection checks, API keys, and worker permissions are managed in the AI tab.
            </span>
          </div>
        </div>
      </section>

      <section
        style={{
          paddingTop: 20,
          borderTop: `1px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            textTransform: "uppercase",
            letterSpacing: "1px",
            color: COLORS.textDim,
          }}
        >
          APP VERSION
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: MONO_FONT,
            color: COLORS.textMuted,
          }}
        >
          v{info.appVersion}
        </span>
        <span
          style={{
            fontSize: 9,
            fontFamily: MONO_FONT,
            color: COLORS.textDim,
            padding: "1px 6px",
            background: `${COLORS.textDim}18`,
            border: `1px solid ${COLORS.textDim}30`,
            borderRadius: 0,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
          }}
        >
          {info.isPackaged ? "PACKAGED" : "DEV"}
        </span>
      </section>
    </div>
  );
}
