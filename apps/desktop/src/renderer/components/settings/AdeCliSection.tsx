import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, CheckCircle, Info, Warning } from "@phosphor-icons/react";
import type { AdeCliStatus } from "../../../shared/types";
import { rendererPlatformAttribute } from "../../lib/platform";
import { ModernRow, ModernRows, ModernSection } from "./primitives";
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
  let statusTone: "ok" | "warn" | "crit" | undefined;
  let statusLabel = "Manual action";
  if (terminalReady) {
    statusTone = "ok";
    statusLabel = "On PATH";
  } else if (bundledReady) {
    statusTone = "warn";
    statusLabel = "Bundled";
  } else if (status) {
    statusTone = "crit";
    statusLabel = "Unavailable";
  }
  const installDisabled = loading || installing || terminalReady || !status?.installAvailable || !window.ade?.adeCli;

  return (
    <ModernSection
      group="Command line"
      anchor="ade-cli"
      title={embedded ? "Terminal CLI" : "Command line"}
      hint={embedded
        ? <>Use <code className="ade-modern-code">ade</code> in your own Terminal. Agents launched by ADE already get the bundled CLI.</>
        : <>Agents launched by ADE get the bundled CLI automatically. Installing it here makes <code className="ade-modern-code">ade</code> available in your Terminal.</>}
      actions={(
        <>
          <button
            type="button"
            className="ade-modern-btn"
            data-variant="ghost"
            disabled={loading || installing}
            onClick={() => void refresh()}
          >
            <ArrowsClockwise size={13} weight="bold" />
            Refresh
          </button>
          <button
            type="button"
            className="ade-modern-btn"
            data-tone={installDisabled ? undefined : "primary"}
            disabled={installDisabled}
            onClick={() => void installForUser()}
          >
            {installing ? "Installing..." : terminalReady ? "Installed" : "Install for Terminal"}
          </button>
        </>
      )}
    >
      {notice ? (
        <Banner layout="inline" model={{ id: "ade-cli-notice", tone: notice.kind, title: notice.text }} />
      ) : null}

      <ModernRows>
        <ModernRow
          title="Agent sessions"
          hint={agentReady ? "Ready for ADE agents" : status?.nextAction ?? "Checking agent PATH"}
          control={<ReadinessTag ready={agentReady} loading={loading} />}
        />
        <ModernRow
          title="Terminal"
          hint={(
            <span className="ade-modern-path">
              {terminalReady ? status?.terminalCommandPath ?? "ade is on PATH" : `Not installed at ${status?.installTargetPath ?? "~/.local/bin/ade"}`}
            </span>
          )}
          control={<span className="kit-tag" data-tone={loading ? undefined : statusTone}>{loading ? "Checking" : statusLabel}</span>}
        />
      </ModernRows>

      {!status?.installTargetDirOnPath && status?.installTargetPath ? (
        <div className="ade-modern-note">
          <Info size={14} />
          <span>
            <span className="kit-num" style={{ fontSize: 11 }}>{installTargetDir}</span> is not on this shell PATH. Agents still get the bundled command; add that directory to your shell PATH for Terminal use.
            {embedded ? null : (
              <>
                {" "}Installing here puts the same <code className="ade-modern-code">ade</code> in your Terminal
                that ADE uses everywhere else. On a machine without the desktop app,{" "}
                <code className="ade-modern-code">{TERMINAL_INSTALL_COMMAND}</code> installs it and sets up
                PATH for you.
              </>
            )}
          </span>
        </div>
      ) : null}

      {!embedded && status?.bundledCommandPath ? (
        <div className="ade-modern-path" style={{ padding: "0 2px" }}>{status.bundledCommandPath}</div>
      ) : null}

      {!status?.installAvailable && !terminalReady ? (
        <p className="ade-modern-muted" style={{ padding: "0 2px" }}>
          {!window.ade?.adeCli
            ? "CLI install status is not available in this build. Agents still use ADE's bundled CLI when launched by ADE."
            : status?.isPackaged
              ? "This ADE build did not include the installer."
              : "Local development uses npm link for Terminal installs."}
        </p>
      ) : null}
    </ModernSection>
  );
}

function ReadinessTag({ ready, loading }: { ready: boolean; loading: boolean }) {
  if (loading) return <span className="kit-tag">Checking</span>;
  return ready
    ? <span className="kit-tag" data-tone="ok"><CheckCircle size={11} weight="fill" style={{ marginRight: 4 }} />Ready</span>
    : <span className="kit-tag" data-tone="warn"><Warning size={11} weight="fill" style={{ marginRight: 4 }} />Not yet</span>;
}
