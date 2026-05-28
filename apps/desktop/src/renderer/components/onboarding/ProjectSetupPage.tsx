import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { useAppStore } from "../../state/appStore";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { publishOnboardingStatusUpdated } from "../../lib/onboardingStatusEvents";
import { DevToolsRow } from "./DevToolsRow";
import { AiRuntimesBand } from "./AiRuntimesBand";
import { GitHubCard } from "./GitHubCard";
import { LinearCard } from "./LinearCard";
import { WorktreesCard } from "./WorktreesCard";

export function ProjectSetupPage() {
  const navigate = useNavigate();
  const project = useAppStore((s) => s.project);
  const [busy, setBusy] = useState(false);
  const [gitInstalled, setGitInstalled] = useState<boolean | null>(null);

  const finish = async () => {
    setBusy(true);
    try {
      const next = await window.ade.onboarding.complete();
      publishOnboardingStatusUpdated(next);
      navigate("/work", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    try {
      const next = await window.ade.onboarding.setDismissed(true);
      publishOnboardingStatusUpdated(next);
      navigate("/work", { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={pageStyle}>
      <div style={glowViolet} aria-hidden />
      <div style={glowBlue} aria-hidden />

      <div style={containerStyle}>
        <header style={headerStyle}>
          <div>
            <div style={eyebrowStyle}>Set up</div>
            <h1 style={titleStyle}>{project?.displayName ?? "Your project"}</h1>
            <p style={subtitleStyle}>
              Connect your tools and accounts. Everything's optional except git — change anything later in Settings.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Button size="md" variant="ghost" disabled={busy} onClick={() => void skip()}>
                Skip
              </Button>
              <Button
                size="md"
                variant="primary"
                disabled={busy || gitInstalled !== true}
                onClick={() => void finish()}
              >
                {busy ? "Saving..." : "Finish setup"}
              </Button>
            </div>
            {gitInstalled === false ? (
              <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.warning }}>
                Install git to finish setup
              </span>
            ) : null}
          </div>
        </header>

        <div style={bodyStyle}>
          <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex" }}>
            <AiRuntimesBand />
          </div>
          <div style={railStyle}>
            <DevToolsRow onGitStatusChange={setGitInstalled} />
            <div style={connectionsRowStyle}>
              <div style={connectionColStyle}><GitHubCard /></div>
              <div style={connectionColStyle}><LinearCard /></div>
            </div>
            <WorktreesCard />
          </div>
        </div>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  position: "relative",
  height: "100%",
  overflow: "auto",
  display: "flex",
  background: `radial-gradient(1200px 600px at 0% -10%, color-mix(in srgb, ${COLORS.accent} 10%, transparent), transparent 60%), ${COLORS.pageBg}`,
};

const glowViolet: React.CSSProperties = {
  position: "absolute",
  top: -120,
  left: "8%",
  width: 480,
  height: 480,
  borderRadius: "50%",
  background: "radial-gradient(circle, rgba(167,139,250,0.16), transparent 70%)",
  filter: "blur(20px)",
  pointerEvents: "none",
};

const glowBlue: React.CSSProperties = {
  position: "absolute",
  bottom: -160,
  right: "6%",
  width: 520,
  height: 520,
  borderRadius: "50%",
  background: "radial-gradient(circle, rgba(96,165,250,0.12), transparent 70%)",
  filter: "blur(20px)",
  pointerEvents: "none",
};

const containerStyle: React.CSSProperties = {
  position: "relative",
  margin: "auto",
  width: "100%",
  maxWidth: 1440,
  padding: "40px 32px",
  display: "flex",
  flexDirection: "column",
  gap: 24,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: 24,
  flexWrap: "wrap",
};

const eyebrowStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: SANS_FONT,
  fontWeight: 700,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: COLORS.accent,
};

const titleStyle: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 30,
  lineHeight: 1.1,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
};

const subtitleStyle: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 13,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  maxWidth: 560,
  lineHeight: 1.55,
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  gap: 20,
  alignItems: "stretch",
  flexWrap: "wrap",
};

const railStyle: React.CSSProperties = {
  flex: "1 1 340px",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const connectionsRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 20,
  alignItems: "stretch",
};

const connectionColStyle: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
};
