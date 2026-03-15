import { useMemo, useState, type CSSProperties } from "react";
import { CheckCircle, Info, WarningCircle } from "@phosphor-icons/react";
import type { LinearConnectionStatus } from "../../../shared/types";
import { LinearConnectionPanel } from "../cto/LinearConnectionPanel";
import { COLORS, SANS_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

export function LinearSection() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [panelReloadToken] = useState(0);

  const isConnected = Boolean(connection?.connected);
  const oauthConfigured = connection?.oauthAvailable === true;
  const authModeLabel = useMemo(() => {
    if (!connection?.authMode) return null;
    return connection.authMode === "oauth" ? "OAuth" : "API key";
  }, [connection?.authMode]);

  const noticeStyle: CSSProperties = {
    background: `${COLORS.warning}08`,
    border: `1px solid ${COLORS.warning}18`,
    padding: "10px 14px",
    fontSize: 11,
    fontFamily: SANS_FONT,
    color: COLORS.textSecondary,
    borderRadius: 10,
    lineHeight: "18px",
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
  };

  return (
    <div style={{ display: "flex", maxWidth: 780, flexDirection: "column", gap: 16 }}>
      <div style={{
        padding: 20,
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
      }}>
        <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{
            minWidth: 220,
            flex: "1 1 240px",
            background: COLORS.recessedBg,
            padding: 14,
            borderRadius: 10,
          }}>
            <div style={LABEL_STYLE}>STATUS</div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 12, color: isConnected ? COLORS.success : COLORS.textMuted }}>
              {isConnected ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} />}
              {isConnected ? "Connected" : "Not connected"}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
              {isConnected
                ? `Signed in${connection?.viewerName ? ` as ${connection.viewerName}` : ""}${authModeLabel ? ` via ${authModeLabel}` : ""}${connection?.projectCount ? ` · ${connection.projectCount} project${connection.projectCount === 1 ? "" : "s"} visible` : ""}.`
                : "Use browser sign-in or an API key to connect."}
            </div>
            {isConnected && (connection?.projectPreview?.length ?? 0) > 0 ? (
              <div style={{ marginTop: 8, fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
                Projects: {connection?.projectPreview?.join(", ")}
              </div>
            ) : null}
          </div>
          <div style={{
            minWidth: 220,
            flex: "1 1 240px",
            background: COLORS.recessedBg,
            padding: 14,
            borderRadius: 10,
          }}>
            <div style={LABEL_STYLE}>BROWSER SIGN-IN</div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontFamily: SANS_FONT, fontSize: 12, color: oauthConfigured ? COLORS.success : COLORS.textMuted }}>
              {oauthConfigured ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} />}
              {oauthConfigured ? "Ready" : "Not configured"}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
              ADE opens Linear in the browser and handles sign-in locally.
            </div>
          </div>
        </div>

        <div style={noticeStyle}>
          <Info size={14} weight="fill" style={{ color: COLORS.warning, flexShrink: 0, marginTop: 1 }} />
          <span>
            <strong style={{ color: COLORS.textPrimary }}>Known Linear OAuth issue:</strong>{" "}
            Clicking &ldquo;Authorize&rdquo; sometimes redirects back to the same page.
            If this happens, return to ADE, switch away from this tab, then come back and try again. Switching browsers can also help.
          </span>
        </div>

        <div style={{ marginTop: 16 }}>
          <LinearConnectionPanel
            reloadToken={panelReloadToken}
            onStatusChange={setConnection}
          />
        </div>
      </div>
    </div>
  );
}
