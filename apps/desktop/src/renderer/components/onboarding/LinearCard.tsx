import React, { useCallback, useEffect, useRef, useState } from "react";
import type { LinearConnectionStatus } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";
import { InputPopover } from "./InputPopover";
import { RescanButton } from "./RescanButton";
import { LinearMark } from "../lanes/linearBrand";
import { BRAND, CARD_BASE, SECTION_LABEL, logoTile, statusDot } from "./onboardingTheme";

const openExternal = (url: string) => {
  try {
    const opener = (window.ade as unknown as { external?: { openExternal?: (u: string) => unknown } }).external;
    if (opener?.openExternal) {
      void opener.openExternal(url);
      return;
    }
  } catch {/* ignore */}
  window.open(url, "_blank", "noopener,noreferrer");
};

export function LinearCard() {
  const [status, setStatus] = useState<LinearConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!window.ade.cto) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await window.ade.cto.getLinearConnectionStatus();
      setStatus(next as LinearConnectionStatus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const beginOAuth = async () => {
    const cto = window.ade.cto;
    if (!cto) {
      setOauthError("Linear OAuth is not available in this build");
      return;
    }
    setOauthBusy(true);
    setOauthError(null);
    try {
      const session = await cto.startLinearOAuth();
      openExternal(session.authUrl);
      const sessionId = session.sessionId;
      pollRef.current = window.setInterval(async () => {
        try {
          const update = await cto.getLinearOAuthSession({ sessionId });
          if (update.status === "completed") {
            if (pollRef.current != null) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
            await refresh();
            setOauthBusy(false);
          } else if (update.status === "failed" || update.status === "expired") {
            if (pollRef.current != null) {
              window.clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setOauthError(update.error ?? "OAuth failed");
            setOauthBusy(false);
          }
        } catch (e) {
          setOauthError(e instanceof Error ? e.message : String(e));
        }
      }, 1500);
    } catch (e) {
      setOauthError(e instanceof Error ? e.message : String(e));
      setOauthBusy(false);
    }
  };

  const saveApiKey = async (token: string) => {
    if (!window.ade.cto) {
      return { ok: false, message: "Linear API is not available in this build" };
    }
    try {
      const next = await window.ade.cto.setLinearToken({ token });
      setStatus(next as LinearConnectionStatus);
      return { ok: (next as LinearConnectionStatus).connected, message: "Linear connected" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };

  const disconnect = async () => {
    if (!window.ade.cto) return;
    try {
      const next = await window.ade.cto.clearLinearToken();
      setStatus(next as LinearConnectionStatus);
    } catch { /* ignore */ }
  };

  const connected = status?.connected === true;
  const tone = connected ? COLORS.success : COLORS.warning;
  const projectPreview = (status?.projectPreview ?? []).slice(0, 3).join(", ");

  return (
    <section style={cardStyle}>
      <div style={headerRow}>
        <span style={logoTile(BRAND.linear)}>
          <LinearMark size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>Linear</span>
            <span style={statusDot(tone)} />
          </div>
          <div style={subtitleStyle}>
            {loading ? "Checking…" : connected ? `Signed in as ${status?.viewerName ?? "you"}` : "Not connected"}
          </div>
        </div>
        {connected ? <RescanButton iconOnly loading={loading} onClick={() => void refresh()} /> : null}
      </div>

      {connected ? (
        <div style={metaList}>
          {status?.organizationName ? (
            <MetaRow label="Workspace" value={status.organizationName} />
          ) : null}
          {typeof status?.projectCount === "number" ? (
            <MetaRow label="Projects" value={String(status.projectCount)} />
          ) : null}
          {projectPreview ? <MetaRow label="Recent" value={projectPreview} dim /> : null}
          <MetaRow label="Signed in via" value={status?.authMode === "oauth" ? "OAuth" : "API key"} />
        </div>
      ) : (
        <div style={{ ...metaList, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.55 }}>
          Connect Linear to link issues to lanes, chats, and PRs.
        </div>
      )}

      {oauthError ? (
        <div style={{ marginTop: 8, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>{oauthError}</div>
      ) : null}

      {connected ? (
        <div style={actionRow}>
          <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div style={actionRow}>
          <Button size="sm" variant="primary" disabled={oauthBusy} onClick={() => void beginOAuth()}>
            {oauthBusy ? "Waiting…" : "Sign in"}
          </Button>
          <InputPopover
            triggerLabel="Use API key"
            triggerVariant="outline"
            title="Linear API key"
            helpText={<>Get a personal API key at <code style={codeStyle}>linear.app/settings/api</code></>}
            placeholder="lin_api_..."
            saveLabel="Connect"
            onSave={saveApiKey}
          />
        </div>
      )}
    </section>
  );
}

function MetaRow({ label, value, dim = false }: { label: string; value: string; dim?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
      <span style={{ ...SECTION_LABEL, fontSize: 10, color: COLORS.textDim }}>{label}</span>
      <span
        style={{
          fontSize: 12,
          fontFamily: SANS_FONT,
          color: dim ? COLORS.textDim : COLORS.textPrimary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  ...CARD_BASE,
  height: "100%",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const headerRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const metaList: React.CSSProperties = {
  marginTop: 14,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const actionRow: React.CSSProperties = {
  marginTop: 14,
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
};

const codeStyle: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 11,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(255,255,255,0.08)",
  color: COLORS.textPrimary,
};
