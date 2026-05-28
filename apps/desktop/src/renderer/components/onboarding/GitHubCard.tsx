import React, { useCallback, useEffect, useState } from "react";
import { GithubLogo } from "@phosphor-icons/react";
import type { GitHubStatus } from "../../../shared/types";
import { COLORS, SANS_FONT, MONO_FONT } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";
import { InputPopover } from "./InputPopover";
import { RescanButton } from "./RescanButton";
import { BRAND, CARD_BASE, SECTION_LABEL, logoTile, statusDot } from "./onboardingTheme";

export function GitHubCard() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const next = await window.ade.github.getStatus(force ? { forceRefresh: true } : undefined);
      setStatus(next as GitHubStatus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const savePat = async (token: string) => {
    try {
      const next = await window.ade.github.setToken(token);
      setStatus(next as GitHubStatus);
      const ok = (next as GitHubStatus).connected;
      return { ok, message: ok ? "Connected" : (next as GitHubStatus).ghAuthError ?? "Token rejected" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  };

  const disconnect = async () => {
    try {
      const next = await window.ade.github.clearToken();
      setStatus(next as GitHubStatus);
    } catch { /* ignore */ }
  };

  const connected = status?.connected === true;
  const tone = connected ? COLORS.success : COLORS.warning;
  const patStored = status?.patTokenStored === true;
  const canDisconnect = status?.authSource === "pat";

  return (
    <section style={cardStyle}>
      <div style={headerRow}>
        <span style={logoTile(BRAND.github)}>
          <GithubLogo size={18} weight="fill" style={{ color: COLORS.textPrimary }} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>GitHub</span>
            <span style={statusDot(tone)} />
          </div>
          <div style={subtitleStyle}>
            {loading ? "Checking…" : connected ? `Signed in as ${status?.userLogin ?? "you"}` : "Not signed in"}
          </div>
        </div>
        <RescanButton iconOnly loading={loading} onClick={() => void refresh(true)} />
      </div>

      {connected ? (
        <div style={metaList}>
          {status?.repo ? (
            <MetaRow label="Repo" value={`${status.repo.owner}/${status.repo.name}`} mono />
          ) : status?.hasOrigin ? (
            <MetaRow label="Repo" value="Non-GitHub remote" dim />
          ) : (
            <MetaRow label="Repo" value="No remote yet" dim />
          )}
          <MetaRow label="Signed in via" value={authLabel(status)} />
          {status?.repo && status.repoAccessOk === false ? (
            <MetaRow label="Access" value="No access — check token scopes" tone={COLORS.danger} />
          ) : null}
        </div>
      ) : (
        <div style={{ ...metaList, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.55 }}>
          Run <code style={codeStyle}>gh auth login</code> then Rescan, or paste a personal access token.
        </div>
      )}

      <div style={actionRow}>
        {canDisconnect ? (
          <Button size="sm" variant="ghost" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : null}
        <InputPopover
          triggerLabel={patStored ? "Replace PAT token" : "Use PAT token"}
          triggerVariant={connected ? "ghost" : "outline"}
          title="GitHub personal access token"
          helpText={
            <>
              Classic token at <code style={codeStyle}>github.com/settings/tokens</code> (needs repo, workflow). Fine-grained also supported.
            </>
          }
          placeholder="ghp_..."
          saveLabel="Save token"
          onSave={savePat}
        />
      </div>
    </section>
  );
}

function MetaRow({
  label, value, mono = false, dim = false, tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  dim?: boolean;
  tone?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
      <span style={{ ...SECTION_LABEL, fontSize: 10, color: COLORS.textDim }}>{label}</span>
      <span
        style={{
          fontSize: mono ? 11.5 : 12,
          fontFamily: mono ? MONO_FONT : SANS_FONT,
          color: tone ?? (dim ? COLORS.textDim : COLORS.textPrimary),
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

function authLabel(status: GitHubStatus | null): string {
  if (!status) return "—";
  if (status.authSource === "gh") return "GitHub CLI";
  if (status.authSource === "environment") return "Environment variable";
  if (status.authSource === "pat") {
    if (status.tokenType === "fine-grained") return "Personal token (fine-grained)";
    if (status.tokenType === "classic") return "Personal token (classic)";
    return "Personal token";
  }
  return "Not signed in";
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
