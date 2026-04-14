import { Globe, Pulse, X } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { DiagnosticsDashboardSection } from "../settings/DiagnosticsDashboardSection";
import { ProxyAndPreviewSection } from "../settings/ProxyAndPreviewSection";

type RunNetworkPanelProps = {
  onClose: () => void;
};

export function RunNetworkPanel({ onClose }: RunNetworkPanelProps) {
  return (
    <aside
      style={{
        width: 420,
        minWidth: 360,
        maxWidth: 460,
        height: "100%",
        background: COLORS.pageBg,
        overflowY: "auto",
        overflowX: "hidden",
        borderLeft: `1px solid ${COLORS.border}`,
      }}
    >
      <div style={{ padding: 20, display: "grid", gap: 16 }}>
        <div
          style={{
            display: "grid",
            gap: 10,
            paddingBottom: 16,
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Preview and routing
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  border: `1px solid ${COLORS.outlineBorder}`,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  color: COLORS.textMuted,
                }}
              >
                <Globe size={12} />
                Run
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close network panel"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  height: 28,
                  background: "transparent",
                  border: `1px solid ${COLORS.outlineBorder}`,
                  color: COLORS.textMuted,
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <X size={14} weight="bold" />
              </button>
            </div>
          </div>
          <div
            style={{
              display: "grid",
              gap: 8,
              padding: "12px 14px",
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.textSecondary,
              fontFamily: MONO_FONT,
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            <div style={{ color: COLORS.textPrimary, fontWeight: 700 }}>
              How this works
            </div>
            <div>1. Start a web command in Run.</div>
            <div>2. ADE detects the live app port for this lane, even if your dev server bumps from 3000 to 3001 or higher.</div>
            <div>3. Open the stable preview URL shown in the Run bar. ADE keeps that URL steady while the app port changes.</div>
            <div>4. If you use OAuth, register the ADE callback URL once and start sign-in from the preview URL.</div>
            <div>5. Use the controls below only if preview routing or callback routing needs setup or debugging.</div>
          </div>
        </div>

        <ProxyAndPreviewSection />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingTop: 4,
            fontSize: 11,
            fontWeight: 700,
            fontFamily: MONO_FONT,
            color: COLORS.textPrimary,
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          <Pulse size={14} />
          Proxy and lane health
        </div>
        <DiagnosticsDashboardSection title="Proxy and lane health" openCodeMode="issues-only" />
      </div>
    </aside>
  );
}
