import React, { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { useOnboardingStore } from "../../state/onboardingStore";
import { docs } from "../../onboarding/docsLinks";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
  dangerButton,
} from "../lanes/laneDesignTokens";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 16,
};

const rowLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
};

const rowDescStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textMuted,
  lineHeight: 1.5,
};

function ToggleRow({
  title,
  description,
  enabled,
  onChange,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={rowLabelStyle}>{title}</div>
        <div style={rowDescStyle}>{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          width: 36,
          height: 20,
          padding: 2,
          borderRadius: 999,
          background: enabled ? COLORS.accent : "rgba(255,255,255,0.06)",
          border: `1px solid ${enabled ? COLORS.accent : COLORS.outlineBorder}`,
          cursor: "pointer",
          transition: "background 120ms",
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 999,
            background: "#fff",
            transform: `translateX(${enabled ? 16 : 0}px)`,
            transition: "transform 120ms",
          }}
        />
      </button>
    </div>
  );
}

export function OnboardingSection() {
  const navigate = useNavigate();
  const onboardingEnabled = useAppStore((s) => s.onboardingEnabled);
  const didYouKnowEnabled = useAppStore((s) => s.didYouKnowEnabled);
  const setOnboardingEnabled = useAppStore((s) => s.setOnboardingEnabled);
  const setDidYouKnowEnabled = useAppStore((s) => s.setDidYouKnowEnabled);
  const openWizard = useOnboardingStore((s) => s.openWizard);
  const startTour = useOnboardingStore((s) => s.startTour);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleReset = useCallback(async () => {
    setResetBusy(true);
    setResetError(null);
    try {
      const ade = (typeof window !== "undefined" ? (window as any).ade : undefined) as
        | { onboarding?: Window["ade"]["onboarding"] }
        | undefined;
      const onboarding = ade?.onboarding ?? null;
      if (onboarding) {
        const progress = await onboarding.resetTourProgress();
        useOnboardingStore.setState({ progress });
      }
      setResetConfirm(false);
    } catch (err) {
      setResetError(String(err));
    } finally {
      setResetBusy(false);
    }
  }, []);

  const handleOpenDocs = useCallback(() => {
    const ade = (typeof window !== "undefined" ? (window as any).ade : undefined) as
      | { app?: { openExternal: (url: string) => Promise<void> } }
      | undefined;
    // TODO(round 3): replaced by pointer-to-HelpMenu rewrite.
    const target = docs.home;
    if (ade?.app?.openExternal) {
      void ade.app.openExternal(target);
    } else if (typeof window !== "undefined") {
      window.open(target, "_blank", "noreferrer");
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section>
        <div style={sectionLabelStyle}>ONBOARDING &amp; HELP</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 16 }}>
          <ToggleRow
            title="Onboarding hints"
            description="Show the welcome wizard on first launch, in-app tours, and the '?' help chips."
            enabled={onboardingEnabled}
            onChange={setOnboardingEnabled}
          />
          <div style={{ height: 1, background: COLORS.border }} />
          <ToggleRow
            title={'"Did you know" hints'}
            description="Occasional ambient tips shown as toasts. Requires Onboarding hints to be on."
            enabled={didYouKnowEnabled}
            onChange={setDidYouKnowEnabled}
          />
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>REPLAY</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={primaryButton()} onClick={() => openWizard()}>
              REPLAY WELCOME WIZARD
            </button>
            <button type="button" style={outlineButton()} onClick={() => { void startTour("lanes"); }}>
              REPLAY LANES TOUR
            </button>
          </div>
          <div style={{ height: 1, background: COLORS.border }} />
          {resetConfirm ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={rowDescStyle}>
                This clears every tour's completed/dismissed state and the list of glossary terms you have opened.
                The welcome wizard may reopen on next launch. You cannot undo this.
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button type="button" style={dangerButton()} disabled={resetBusy} onClick={() => { void handleReset(); }}>
                  {resetBusy ? "RESETTING…" : "YES, RESET"}
                </button>
                <button type="button" style={outlineButton()} disabled={resetBusy} onClick={() => setResetConfirm(false)}>
                  CANCEL
                </button>
              </div>
              {resetError ? (
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.danger }}>{resetError}</div>
              ) : null}
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" style={dangerButton()} onClick={() => setResetConfirm(true)}>
                RESET ALL ONBOARDING PROGRESS
              </button>
            </div>
          )}
        </div>
      </section>

      <section>
        <div style={sectionLabelStyle}>LEARN MORE</div>
        <div style={{ ...cardStyle(), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" style={outlineButton()} onClick={() => navigate("/glossary")}>
              OPEN GLOSSARY
            </button>
            <button type="button" style={outlineButton()} onClick={handleOpenDocs}>
              ADE DOCS ↗
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
