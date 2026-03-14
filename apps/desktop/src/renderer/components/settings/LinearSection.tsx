import { useMemo, useState, type CSSProperties } from "react";
import { ArrowSquareOut, CheckCircle, Plugs, WarningCircle, XCircle } from "@phosphor-icons/react";
import type { LinearConnectionStatus } from "../../../shared/types";
import { LinearConnectionPanel } from "../cto/LinearConnectionPanel";
import { COLORS, MONO_FONT, SANS_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const LINEAR_OAUTH_DOCS_URL = "https://linear.app/developers/oauth-authentication";

export function LinearSection() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [panelReloadToken, setPanelReloadToken] = useState(0);
  const [clientIdDraft, setClientIdDraft] = useState("");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isConnected = Boolean(connection?.connected);
  const oauthConfigured = connection?.oauthAvailable === true;
  const authModeLabel = useMemo(() => {
    if (!connection?.authMode) return null;
    return connection.authMode === "oauth" ? "OAuth" : "API key";
  }, [connection?.authMode]);

  const handleSaveOAuthClient = async () => {
    const cto = window.ade?.cto;
    if (!cto) {
      setError("Linear settings are unavailable right now.");
      return;
    }
    const clientId = clientIdDraft.trim();
    if (!clientId.length) {
      setError("Linear OAuth client ID is required.");
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const status = await cto.setLinearOAuthClient({
        clientId,
        clientSecret: clientSecretDraft.trim() || null,
      });
      setConnection(status);
      setPanelReloadToken((value) => value + 1);
      setNotice("Linear OAuth app saved. You can now sign in with Linear.");
      setClientSecretDraft("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const handleClearOAuthClient = async () => {
    const cto = window.ade?.cto;
    if (!cto) {
      setError("Linear settings are unavailable right now.");
      return;
    }
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const status = await cto.clearLinearOAuthClient();
      setConnection(status);
      setPanelReloadToken((value) => value + 1);
      setClientIdDraft("");
      setClientSecretDraft("");
      setNotice("Linear OAuth app cleared.");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setBusy(false);
    }
  };

  const noticeStyle: CSSProperties = {
    background: `${COLORS.success}12`,
    border: `1px solid ${COLORS.success}30`,
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.success,
    borderRadius: 0,
  };

  const errorStyle: CSSProperties = {
    background: `${COLORS.danger}12`,
    border: `1px solid ${COLORS.danger}30`,
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.danger,
    borderRadius: 0,
  };

  const inputStyle: CSSProperties = {
    height: 36,
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 0,
    padding: "0 12px",
    fontSize: 12,
    fontFamily: MONO_FONT,
    color: COLORS.textPrimary,
    outline: "none",
    width: "100%",
  };

  return (
    <div style={{ display: "flex", maxWidth: 780, flexDirection: "column", gap: 16 }}>
      {notice ? <div style={noticeStyle}>{notice}</div> : null}
      {error ? <div style={errorStyle}>{error}</div> : null}

      <div style={cardStyle()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Plugs size={28} weight="fill" style={{ color: COLORS.textPrimary }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                Linear connection
              </div>
              <div style={{ marginTop: 4, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted }}>
                Connect Linear once here, then use the CTO Linear workspace for routing and automation.
              </div>
            </div>
          </div>
          <button
            type="button"
            style={outlineButton()}
            onClick={() => void window.ade.app.openExternal(LINEAR_OAUTH_DOCS_URL)}
          >
            <ArrowSquareOut size={12} weight="bold" /> LINEAR OAUTH DOCS
          </button>
        </div>

        <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{
            minWidth: 220,
            flex: "1 1 240px",
            background: COLORS.recessedBg,
            padding: 14,
            borderRadius: 0,
          }}>
            <div style={LABEL_STYLE}>STATUS</div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontFamily: MONO_FONT, fontSize: 12, color: isConnected ? COLORS.success : COLORS.textMuted }}>
              {isConnected ? <CheckCircle size={14} weight="fill" /> : <WarningCircle size={14} />}
              {isConnected ? "CONNECTED" : "NOT CONNECTED"}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
              {isConnected
                ? `Connected${connection?.viewerName ? ` as ${connection.viewerName}` : ""}${authModeLabel ? ` via ${authModeLabel}` : ""}.`
                : "Use API key or browser sign-in below. The CTO Linear tab will pick this up automatically."}
            </div>
          </div>
          <div style={{
            minWidth: 220,
            flex: "1 1 240px",
            background: COLORS.recessedBg,
            padding: 14,
            borderRadius: 0,
          }}>
            <div style={LABEL_STYLE}>OAUTH APP</div>
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontFamily: MONO_FONT, fontSize: 12, color: oauthConfigured ? COLORS.success : COLORS.textMuted }}>
              {oauthConfigured ? <CheckCircle size={14} weight="fill" /> : <XCircle size={14} />}
              {oauthConfigured ? "READY" : "NOT CONFIGURED"}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
              Linear’s browser OAuth flow uses an app client ID. For public clients, PKCE is supported, so the client secret is optional.
            </div>
          </div>
        </div>

        <LinearConnectionPanel
          reloadToken={panelReloadToken}
          onStatusChange={setConnection}
        />
      </div>

      <div style={cardStyle()}>
        <div style={{ marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              Browser OAuth app
            </div>
            <div style={{ marginTop: 4, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, lineHeight: "18px" }}>
              This replaces the old secret-file setup. Paste the Linear OAuth app details here once and ADE will use them for browser sign-in.
            </div>
          </div>
          {oauthConfigured ? (
            <button type="button" style={outlineButton()} disabled={busy} onClick={() => void handleClearOAuthClient()}>
              CLEAR OAUTH APP
            </button>
          ) : null}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label>
            <div style={LABEL_STYLE}>CLIENT ID</div>
            <input
              value={clientIdDraft}
              onChange={(event) => setClientIdDraft(event.target.value)}
              placeholder="lin_oauth_client_..."
              style={{ ...inputStyle, marginTop: 6 }}
            />
          </label>
          <label>
            <div style={LABEL_STYLE}>CLIENT SECRET (OPTIONAL)</div>
            <input
              value={clientSecretDraft}
              onChange={(event) => setClientSecretDraft(event.target.value)}
              placeholder="Leave blank for PKCE / public client flows"
              style={{ ...inputStyle, marginTop: 6 }}
              type="password"
            />
          </label>
        </div>

        <div style={{ marginTop: 12, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textSecondary, lineHeight: "18px" }}>
          Create the OAuth app in Linear, set the redirect URI to the local callback ADE opens during sign-in, then click save here. ADE opens the browser and completes the token exchange locally.
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
          <button type="button" style={primaryButton()} disabled={busy || !clientIdDraft.trim()} onClick={() => void handleSaveOAuthClient()}>
            SAVE OAUTH APP
          </button>
          {!oauthConfigured ? (
            <button
              type="button"
              style={outlineButton()}
              onClick={() => void window.ade.app.openExternal(LINEAR_OAUTH_DOCS_URL)}
            >
              <ArrowSquareOut size={12} weight="bold" /> OPEN DOCS
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
