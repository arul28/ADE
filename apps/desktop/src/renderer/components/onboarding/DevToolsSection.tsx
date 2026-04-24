import React, { useEffect, useState, useCallback } from "react";
import { ArrowsClockwise, GitBranch } from "@phosphor-icons/react";
import type { DevToolsCheckResult, DevToolStatus } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT, inlineBadge } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";
import { AdeCliSection } from "../settings/AdeCliSection";

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
  const platform = result?.platform ?? "darwin";

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Info header */}
      <div style={{
        padding: "14px 16px",
        borderRadius: 12,
        border: `1px solid ${COLORS.border}`,
        background: "rgba(255,255,255,0.03)",
        fontSize: 12,
        fontFamily: SANS_FONT,
        color: COLORS.textMuted,
        lineHeight: 1.7,
      }}>
        <div style={{ fontWeight: 500, color: COLORS.textSecondary, marginBottom: 6 }}>
          ADE relies on these developer tools
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: COLORS.textMuted }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <GitBranch size={12} weight="bold" style={{ color: COLORS.success, flexShrink: 0 }} />
            <span><strong style={{ color: COLORS.textSecondary }}>git</strong> — version control, branching, and lane isolation</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 12, display: "inline-flex", justifyContent: "center", color: COLORS.info }}>$</span>
            <span><strong style={{ color: COLORS.textSecondary }}>ade</strong> — bundled command for agent sessions, optional Terminal install</span>
          </div>
        </div>
      </div>

      <ToolCard tool={git} platform={platform} loading={loading && !result} />
      <AdeCliSection compact />

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void detect(true)}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ArrowsClockwise size={13} weight="bold" style={{ opacity: loading ? 0.4 : 1 }} />
            {loading ? "Checking..." : "Scan again"}
          </span>
        </Button>
      </div>
    </div>
  );
}

function ToolCard({ tool, platform, loading }: { tool: DevToolStatus | null; platform: NodeJS.Platform; loading: boolean }) {
  const accentColor = COLORS.success;
  const Icon = GitBranch;

  if (loading || !tool) {
    return (
      <div style={cardStyle(accentColor)}>
        <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Detecting...</div>
      </div>
    );
  }

  const installed = tool.installed;
  const statusColor = installed ? COLORS.success : tool.required ? COLORS.danger : COLORS.warning;
  const statusLabel = installed ? "Installed" : "Not found";
  const requirementLabel = tool.required ? "Required to continue setup." : "Optional";

  return (
    <div style={cardStyle(accentColor)}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: `${accentColor}12`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}>
            <Icon size={16} weight="duotone" style={{ color: accentColor }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              {tool.label}
            </div>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
              {requirementLabel}
            </div>
          </div>
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
        <div style={{ marginTop: 12 }}>
          <div style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(0,0,0,0.3)",
            border: `1px solid ${COLORS.borderMuted}`,
            fontSize: 12,
            fontFamily: SANS_FONT,
            color: COLORS.textMuted,
            lineHeight: "22px",
          }}>
            {gitInstallHelp(platform)}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: 1.5 }}>
            After installing, click <strong style={{ color: COLORS.textPrimary }}>Scan again</strong>. Restart ADE only if the tool still does not appear.
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

function cardStyle(accentColor: string): React.CSSProperties {
  return {
    padding: 18,
    background: COLORS.cardBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 14,
    borderLeft: `3px solid ${accentColor}`,
  };
}

function codeStyle(): React.CSSProperties {
  return {
    fontFamily: MONO_FONT,
    fontSize: 11,
    padding: "2px 6px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.08)",
    color: COLORS.textPrimary,
  };
}
