import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ArrowsClockwise, CheckCircle, Warning } from "@phosphor-icons/react";
import type { AdeCliStatus } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { rendererPlatformAttribute } from "../../lib/platform";
import { SettingsCard, SettingsGroup } from "./primitives";
import { Banner } from "../ui/notice";

/**
 * The terminal installer this card's button mirrors: it drops the same `ade`
 * binary and, since it also manages shell PATH, is the answer for machines
 * that never get the desktop app.
 */
const TERMINAL_INSTALL_COMMAND = rendererPlatformAttribute() === "win32"
  ? "irm https://ade-app.dev/install.ps1 | iex"
  : "curl -fsSL https://ade-app.dev/install.sh | sh";

type Props = {
  embedded?: boolean;
};

type Notice = {
  kind: "success" | "error";
  text: string;
} | null;

export function AdeCliSection({ embedded = false }: Props) {
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
    <SettingsGroup title="Command line">
      <SettingsCard
        anchor="ade-cli"
        title={embedded ? "Terminal CLI" : "ADE command"}
        description={embedded
          ? <>Use <code style={codeStyle()}>ade</code> in your own Terminal. Agents launched by ADE already get the bundled CLI.</>
          : <>Agents launched by ADE get the bundled CLI automatically. Installing it here makes <code style={codeStyle()}>ade</code> available in your Terminal.</>}
        control={<span style={inlineBadge(statusColor)}>{loading ? "Checking" : statusLabel}</span>}
      >
        {notice ? (
          <Banner
            layout="inline"
            style={{ marginBottom: 14 }}
            model={{ id: "ade-cli-notice", tone: notice.kind, title: notice.text }}
          />
        ) : null}

        <div style={{ display: "grid", gap: 8 }}>
          <ReadinessRow
            ready={agentReady}
            label="Agent sessions"
            value={agentReady ? "Ready for ADE agents" : status?.nextAction ?? "Checking agent PATH"}
          />
          <ReadinessRow
            ready={terminalReady}
            label="Terminal"
            value={terminalReady ? status?.terminalCommandPath ?? "ade is on PATH" : `Not installed at ${status?.installTargetPath ?? "~/.local/bin/ade"}`}
          />
        </div>

        {!embedded && status?.bundledCommandPath ? (
          <div style={{ marginTop: 14, fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textDim, overflowWrap: "anywhere" }}>
            {status.bundledCommandPath}
          </div>
        ) : null}

        {!status?.installTargetDirOnPath && status?.installTargetPath ? (
          <div style={{ ...infoBoxStyle(), marginTop: 14 }}>
            {installTargetDir} is not on this shell PATH. Agents still get the bundled command; add that directory to your shell PATH for Terminal use.
            {embedded ? null : (
              <>
                {" "}Installing here puts the same <code style={codeStyle()}>ade</code> in your Terminal
                that ADE uses everywhere else. On a machine without the desktop app,{" "}
                <code style={codeStyle()}>{TERMINAL_INSTALL_COMMAND}</code> installs it and sets up
                PATH for you.
              </>
            )}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
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
      </SettingsCard>
    </SettingsGroup>
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
    background: "color-mix(in srgb, var(--color-info) 8%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-info) 20%, transparent)",
    borderRadius: 0,
    padding: "9px 12px",
    fontSize: 11,
    fontFamily: MONO_FONT,
    color: COLORS.textSecondary,
    lineHeight: "18px",
  };
}
