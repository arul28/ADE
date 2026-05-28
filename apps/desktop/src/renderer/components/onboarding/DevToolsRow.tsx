import React, { useCallback, useEffect, useState } from "react";
import { GitBranch, TerminalWindow } from "@phosphor-icons/react";
import type { AdeCliStatus, DevToolsCheckResult } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { Button } from "../ui/Button";
import { RescanButton } from "./RescanButton";
import { CARD_BASE, SECTION_LABEL, statusDot } from "./onboardingTheme";

type Props = {
  onGitStatusChange: (installed: boolean) => void;
};

export function DevToolsRow({ onGitStatusChange }: Props) {
  const [devTools, setDevTools] = useState<DevToolsCheckResult | null>(null);
  const [adeCli, setAdeCli] = useState<AdeCliStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setScanError(null);
    try {
      const tools = await window.ade.devTools.detect(force);
      setDevTools(tools);
      const git = tools.tools.find((t) => t.id === "git");
      onGitStatusChange(git?.installed ?? false);
    } catch (e) {
      setDevTools(null);
      onGitStatusChange(false);
      setScanError(e instanceof Error ? e.message : String(e));
    }
    try {
      const cli = await (window.ade.adeCli?.getStatus?.() ?? Promise.resolve(null));
      setAdeCli(cli);
    } catch {
      setAdeCli(null);
    } finally {
      setLoading(false);
    }
  }, [onGitStatusChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  const installAde = async () => {
    if (!window.ade.adeCli?.installForUser) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await window.ade.adeCli.installForUser();
      setAdeCli(result.status);
      if (!result.ok) setInstallError(result.message);
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const git = devTools?.tools.find((t) => t.id === "git") ?? null;
  const gitInstalled = git?.installed ?? false;
  const adeTerminalReady = adeCli?.terminalInstalled === true;
  const adeBundled = adeCli?.bundledAvailable === true;
  const canAddToPath = !adeTerminalReady && adeCli?.installAvailable === true;

  return (
    <section style={CARD_BASE}>
      <div style={sectionHeader}>
        <span style={SECTION_LABEL}>Essentials</span>
        <RescanButton loading={loading} onClick={() => void refresh(true)} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <ToolRow
          icon={<GitBranch size={15} weight="duotone" />}
          tone={gitInstalled ? COLORS.success : COLORS.danger}
          required={!gitInstalled}
          title="Git"
          detail={
            gitInstalled
              ? `Installed · ${git?.detectedVersion ?? "ready"}`
              : installHint(devTools?.platform ?? "darwin")
          }
        />
        <ToolRow
          icon={<TerminalWindow size={15} weight="duotone" />}
          tone={adeTerminalReady ? COLORS.success : adeBundled ? COLORS.warning : COLORS.danger}
          title="ADE CLI"
          detail={
            adeTerminalReady
              ? "Installed · on your terminal PATH"
              : adeBundled
                ? "Installed · not on your terminal PATH"
                : "Not detected"
          }
          action={
            canAddToPath ? (
              <Button
                size="sm"
                variant="outline"
                disabled={installing || loading}
                onClick={() => void installAde()}
              >
                {installing ? "Adding…" : "Add to PATH"}
              </Button>
            ) : null
          }
        />
      </div>
      {installError ? (
        <div style={{ marginTop: 10, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>
          {installError}
        </div>
      ) : null}
      {scanError ? (
        <div style={{ marginTop: 10, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>
          {scanError}
        </div>
      ) : null}
    </section>
  );
}

function ToolRow({
  icon, tone, title, detail, action, required = false,
}: {
  icon: React.ReactNode;
  tone: string;
  title: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
      <span style={statusDot(tone, 9)} />
      <span style={{ display: "inline-flex", alignItems: "center", color: COLORS.textMuted, flexShrink: 0 }}>
        {icon}
      </span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
          {title}
        </span>
        {required ? (
          <span style={{ fontSize: 9, fontWeight: 700, fontFamily: SANS_FONT, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.accent }}>
            Required
          </span>
        ) : null}
        <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {detail}
        </span>
      </div>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

function installHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "brew install git";
  if (platform === "win32") return "git-scm.com";
  return "sudo apt install git";
}

const sectionHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 14,
};
