import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ArrowsClockwise, CheckCircle, TerminalWindow, Warning } from "@phosphor-icons/react";
import type { AdeCliStatus } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

type Props = {
  compact?: boolean;
};

type Notice = {
  kind: "success" | "error";
  text: string;
} | null;

export function AdeCliSection({ compact = false }: Props) {
  const [status, setStatus] = useState<AdeCliStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const refresh = useCallback(async () => {
    const api = window.ade?.adeCli;
    if (!api) {
      setStatus(null);
      setNotice(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setStatus(await api.getStatus());
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installForUser = async () => {
    const api = window.ade?.adeCli;
    if (!api || !status?.installAvailable) return;
    setInstalling(true);
    setNotice(null);
    try {
      const result = await api.installForUser();
      setStatus(result.status);
      setNotice({ kind: result.ok ? "success" : "error", text: result.message });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setInstalling(false);
    }
  };

  const terminalReady = status?.terminalInstalled === true;
  const agentReady = status?.agentPathReady === true;
  const bundledReady = status?.bundledAvailable === true;
  const installTargetDir = status?.installTargetPath
    ? status.installTargetPath.replace(/[\\/](?:ade|ade\.cmd)$/i, "")
    : "";
  let statusColor: string = COLORS.textMuted;
  let statusLabel = "Manual action";
  if (terminalReady) {
    statusColor = COLORS.success;
    statusLabel = "On PATH";
  } else if (bundledReady) {
    statusColor = COLORS.warning;
    statusLabel = "Bundled";
  } else if (status) {
    statusColor = COLORS.danger;
    statusLabel = "Unavailable";
  }
  const installDisabled = loading || installing || terminalReady || !status?.installAvailable || !window.ade?.adeCli;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 12 : 16 }}>
      {notice ? (
        <div style={noticeStyle(notice.kind)}>
          {notice.text}
        </div>
      ) : null}

      <div style={cardStyle({ borderColor: `${statusColor}30` })}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <TerminalWindow size={28} weight="duotone" style={{ color: statusColor, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                ADE command
              </div>
              <div style={{ marginTop: 4, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: "18px" }}>
                Agents launched by ADE get the bundled CLI automatically. Installing it here makes <code style={codeStyle()}>ade</code> available in your Terminal.
              </div>
            </div>
          </div>
          <span style={inlineBadge(statusColor)}>{loading ? "Checking" : statusLabel}</span>
        </div>

        <div style={{ display: "grid", gap: 8, marginTop: 18 }}>
          <ReadinessRow
            ready={agentReady}
            label="Agent sessions"
            value={agentReady ? "ade is on the ADE agent PATH" : status?.nextAction ?? "Checking agent PATH"}
          />
          <ReadinessRow
            ready={terminalReady}
            label="Terminal"
            value={terminalReady ? status?.terminalCommandPath ?? "ade is on PATH" : `Not installed at ${status?.installTargetPath ?? "~/.local/bin/ade"}`}
          />
        </div>

        {status?.bundledCommandPath ? (
          <div style={{ marginTop: 14, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, overflowWrap: "anywhere" }}>
            {status.bundledCommandPath}
          </div>
        ) : null}

        {!status?.installTargetDirOnPath && status?.installTargetPath ? (
          <div style={{ ...infoBoxStyle(), marginTop: 14 }}>
            {installTargetDir} is not on this shell PATH. Agents still get the bundled command; add that directory to your shell PATH for Terminal use.
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 18, flexWrap: "wrap" }}>
          <button type="button" style={outlineButton({ height: 32 })} disabled={loading || installing} onClick={() => void refresh()}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ArrowsClockwise size={13} weight="bold" />
              Refresh
            </span>
          </button>
          <button type="button" style={primaryButton({ height: 32 })} disabled={installDisabled} onClick={() => void installForUser()}>
            {installing ? "Installing..." : terminalReady ? "Installed" : "Install for Terminal"}
          </button>
        </div>

        {!status?.installAvailable && !terminalReady ? (
          <div style={{ marginTop: 10, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, lineHeight: "18px" }}>
            {!window.ade?.adeCli
              ? "CLI install status is not available in this build. Agents still use ADE's bundled CLI when launched by ADE."
              : status?.isPackaged
                ? "This ADE build did not include the installer."
                : "Local development uses npm link for Terminal installs."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReadinessRow({ ready, label, value }: { ready: boolean; label: string; value: string }) {
  const Icon = ready ? CheckCircle : Warning;
  const color = ready ? COLORS.success : COLORS.warning;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 110px minmax(0, 1fr)", alignItems: "center", gap: 8 }}>
      <Icon size={15} weight="fill" style={{ color }} />
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>{label}</div>
      <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textMuted, overflowWrap: "anywhere" }}>{value}</div>
    </div>
  );
}

function codeStyle(): CSSProperties {
  return {
    fontFamily: MONO_FONT,
    fontSize: 11,
    padding: "1px 4px",
    borderRadius: 4,
    background: "rgba(255,255,255,0.08)",
    color: COLORS.textPrimary,
  };
}

function infoBoxStyle(): CSSProperties {
  return {
    background: `${COLORS.info}08`,
    border: `1px solid ${COLORS.info}20`,
    borderRadius: 0,
    padding: "9px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.textSecondary,
    lineHeight: "18px",
  };
}

function noticeStyle(kind: "success" | "error"): CSSProperties {
  const color = kind === "success" ? COLORS.success : COLORS.danger;
  return {
    background: `${color}12`,
    border: `1px solid ${color}30`,
    padding: "8px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color,
    borderRadius: 0,
  };
}
