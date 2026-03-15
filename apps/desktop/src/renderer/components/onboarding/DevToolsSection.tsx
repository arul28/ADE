import React, { useEffect, useState, useCallback } from "react";
import type { DevToolsCheckResult, DevToolStatus } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT, inlineBadge } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";

type Props = {
  onStatusChange: (gitInstalled: boolean) => void;
};

export function DevToolsSection({ onStatusChange }: Props) {
  const [result, setResult] = useState<DevToolsCheckResult | null>(null);
  const [loading, setLoading] = useState(true);

  const detect = useCallback(async (force?: boolean) => {
    setLoading(true);
    try {
      const r = await window.ade.devTools.detect(force);
      setResult(r);
      const git = r.tools.find((t) => t.id === "git");
      onStatusChange(git?.installed ?? false);
    } catch {
      // leave previous result in place
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => { void detect(); }, [detect]);

  const git = result?.tools.find((t) => t.id === "git") ?? null;
  const gh = result?.tools.find((t) => t.id === "gh") ?? null;
  const platform = result?.platform ?? "darwin";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <ToolCard tool={git} platform={platform} loading={loading && !result} />
      <ToolCard tool={gh} platform={platform} loading={loading && !result} />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void detect(true)}>
          {loading ? "Checking..." : "Re-check"}
        </Button>
      </div>
    </div>
  );
}

function ToolCard({ tool, platform, loading }: { tool: DevToolStatus | null; platform: NodeJS.Platform; loading: boolean }) {
  if (loading || !tool) {
    return (
      <div style={cardStyle()}>
        <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Detecting...</div>
      </div>
    );
  }

  const installed = tool.installed;
  const statusColor = installed ? COLORS.success : tool.required ? COLORS.danger : COLORS.warning;
  const statusLabel = installed ? "INSTALLED" : "NOT INSTALLED";
  const kindLabel = tool.required ? "REQUIRED" : "RECOMMENDED";
  const kindColor = tool.required ? COLORS.danger : COLORS.warning;

  return (
    <div style={cardStyle()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
            {tool.label}
          </div>
          <span style={inlineBadge(kindColor)}>{kindLabel}</span>
        </div>
        <span style={inlineBadge(statusColor)}>{statusLabel}</span>
      </div>

      {installed ? (
        <div style={{ marginTop: 10, fontSize: 12, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: "20px" }}>
          {tool.detectedVersion && <div>{tool.detectedVersion}</div>}
          {tool.detectedPath && (
            <div style={{ fontSize: 11, color: COLORS.textDim }}>{tool.detectedPath}</div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "20px" }}>
            {tool.id === "git" ? gitInstallHelp(platform) : ghInstallHelp(platform)}
          </div>
        </div>
      )}
    </div>
  );
}

function gitInstallHelp(platform: NodeJS.Platform): React.ReactNode {
  if (platform === "darwin") {
    return (
      <>
        Install with <code style={codeStyle()}>xcode-select --install</code> or{" "}
        <code style={codeStyle()}>brew install git</code>
      </>
    );
  }
  if (platform === "win32") {
    return <>Download from git-scm.com and run the installer.</>;
  }
  return (
    <>
      Install with <code style={codeStyle()}>sudo apt install git</code> or{" "}
      <code style={codeStyle()}>sudo dnf install git</code>
    </>
  );
}

function ghInstallHelp(platform: NodeJS.Platform): React.ReactNode {
  if (platform === "darwin") {
    return (
      <>
        Install with <code style={codeStyle()}>brew install gh</code>
      </>
    );
  }
  if (platform === "win32") {
    return (
      <>
        Install with <code style={codeStyle()}>winget install GitHub.cli</code>
      </>
    );
  }
  return <>Install from cli.github.com</>;
}

function cardStyle(): React.CSSProperties {
  return {
    padding: 18,
    background: COLORS.cardBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 14,
  };
}

function codeStyle(): React.CSSProperties {
  return {
    fontFamily: MONO_FONT,
    fontSize: 11,
    padding: "2px 6px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.06)",
    color: COLORS.textPrimary,
  };
}
