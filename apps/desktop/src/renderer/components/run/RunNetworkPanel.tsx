import { Globe, Pulse } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { DiagnosticsDashboardSection } from "../settings/DiagnosticsDashboardSection";
import { ProxyAndPreviewSection } from "../settings/ProxyAndPreviewSection";

export function RunNetworkPanel() {
  return (
    <aside
      style={{
        width: 420,
        minWidth: 360,
        maxWidth: 460,
        borderLeft: `1px solid ${COLORS.border}`,
        background: COLORS.pageBg,
        overflowY: "auto",
        overflowX: "hidden",
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
          </div>
          <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
            Manage the reverse proxy, callback routing, redirect URIs, and lane runtime health from the same surface where commands actually run.
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
          Runtime health
        </div>
        <DiagnosticsDashboardSection />
      </div>
    </aside>
  );
}
