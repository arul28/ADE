import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ComputerUseSettingsSnapshot } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { formatComputerUseKind } from "../../lib/computerUse";

const cardStyle: React.CSSProperties = {
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
  padding: 14,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase",
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

function StatusPill({ label, tone }: { label: string; tone: "success" | "warning" | "muted" | "info" }) {
  const color = tone === "success"
    ? COLORS.success
    : tone === "warning"
      ? COLORS.warning
      : tone === "info"
        ? COLORS.info
        : COLORS.textDim;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        fontSize: 9,
        fontWeight: 700,
        fontFamily: MONO_FONT,
        textTransform: "uppercase",
        letterSpacing: "1px",
        color,
        border: `1px solid ${color}35`,
        background: `${color}12`,
      }}
    >
      {label}
    </span>
  );
}

function BackendCard({
  title,
  tone,
  detail,
  helper,
  diagnostics,
  badges,
  actions,
}: {
  title: string;
  tone: "success" | "warning" | "muted" | "info";
  detail: string;
  helper: string;
  diagnostics?: string[];
  badges?: Array<{ label: string; tone: "success" | "warning" | "muted" | "info" }>;
  actions?: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <div style={cardStyle}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div style={sectionLabel}>{title}</div>
          <div
            className="mt-2 text-[13px] font-semibold"
            style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
          >
            {detail}
          </div>
          <div
            className="mt-2 text-[11px]"
            style={{ color: COLORS.textSecondary, lineHeight: 1.5 }}
          >
            {helper}
          </div>
        </div>
        <StatusPill
          label={tone === "success" ? "Ready" : tone === "warning" ? "Attention" : tone === "info" ? "Supported" : "Unavailable"}
          tone={tone}
        />
      </div>
      {badges?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {badges.map((badge) => (
            <StatusPill key={badge.label} label={badge.label} tone={badge.tone} />
          ))}
        </div>
      ) : null}
      {diagnostics?.length ? (
        <div
          className="mt-3 grid gap-1 text-[10px]"
          style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT, lineHeight: 1.5 }}
        >
          {diagnostics.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
      {actions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action) => (
            <button key={action.label} type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })} onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ComputerUseSection({
  onOpenExternalMcp,
}: {
  onOpenExternalMcp: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ComputerUseSettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void window.ade.computerUse.getSettings()
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = refresh();
    return () => {
      cancel();
    };
  }, [refresh]);

  useEffect(() => {
    if (!window.ade?.externalMcp?.onEvent) return undefined;
    return window.ade.externalMcp.onEvent(() => {
      refresh();
    });
  }, [refresh]);

  const availableBackends = useMemo(
    () => snapshot?.backendStatus.backends.filter((backend) => backend.available) ?? [],
    [snapshot],
  );

  if (loading) {
    return <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>Loading computer-use readiness...</div>;
  }

  if (!snapshot) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12 }}>
        {error ?? "Computer-use readiness is unavailable."}
      </div>
    );
  }

  const ghostOs = snapshot.backendStatus.backends.find((backend) => backend.name === "Ghost OS") ?? null;
  const agentBrowser = snapshot.backendStatus.backends.find((backend) => backend.name === "agent-browser") ?? null;
  const ghostCheck = snapshot.ghostOsCheck;

  return (
    <div style={{ maxWidth: 980, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={cardStyle}>
        <div style={sectionLabel}>Computer Use</div>
        <div className="mt-2 text-[18px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
          ADE is the proof and artifact control plane.
        </div>
        <div className="mt-3 max-w-4xl text-[12px]" style={{ color: COLORS.textSecondary, lineHeight: 1.6 }}>
          {snapshot.guidance.overview}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <StatusPill label={availableBackends.length > 0 ? `${availableBackends.length} external backend${availableBackends.length === 1 ? "" : "s"} ready` : "no external backends ready"} tone={availableBackends.length > 0 ? "success" : "warning"} />
          <StatusPill label={snapshot.backendStatus.localFallback.available ? "local fallback available" : "local fallback unavailable"} tone={snapshot.backendStatus.localFallback.available ? "info" : "muted"} />
          <StatusPill label={snapshot.preferredBackend ? `preferred ${snapshot.preferredBackend}` : "auto backend selection"} tone="info" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <BackendCard
          title="Ghost OS (External MCP)"
          tone={ghostCheck.adeConnected ? "success" : ghostCheck.cliInstalled ? "warning" : "muted"}
          detail={ghostCheck.summary}
          helper={snapshot.guidance.ghostOs}
          badges={[
            {
              label: ghostCheck.cliInstalled ? "ghost installed" : "ghost missing",
              tone: ghostCheck.cliInstalled ? "success" : "muted",
            },
            {
              label:
                ghostCheck.setupState === "ready"
                  ? "setup ready"
                  : ghostCheck.setupState === "needs_setup"
                    ? "needs ghost setup"
                    : ghostCheck.setupState === "not_installed"
                      ? "setup blocked"
                      : "setup unknown",
              tone:
                ghostCheck.setupState === "ready"
                  ? "success"
                  : ghostCheck.setupState === "unknown"
                    ? "info"
                    : "warning",
            },
            {
              label: ghostCheck.adeConfigured ? "ade configured" : "not in ade",
              tone: ghostCheck.adeConfigured ? "info" : "warning",
            },
            {
              label: ghostCheck.adeConnected ? "ade connected" : "not connected",
              tone: ghostCheck.adeConnected ? "success" : "warning",
            },
          ]}
          diagnostics={ghostCheck.details}
          actions={[
            { label: "Open External MCP", onClick: onOpenExternalMcp },
            { label: "Ghost OS Repo", onClick: () => void window.ade.app.openExternal(ghostCheck.repoUrl) },
          ]}
        />
        <BackendCard
          title="agent-browser (External CLI)"
          tone={agentBrowser?.available ? "success" : "warning"}
          detail={agentBrowser?.detail ?? "Install agent-browser on the host machine so ADE can detect CLI-backed browser proof workflows."}
          helper={snapshot.guidance.agentBrowser}
          actions={[
            { label: "agent-browser Docs", onClick: () => void window.ade.app.openExternal("https://github.com/vercel-labs/agent-browser") },
          ]}
        />
        <BackendCard
          title="ADE Local Fallback"
          tone={snapshot.backendStatus.localFallback.available ? "info" : "muted"}
          detail={snapshot.backendStatus.localFallback.detail}
          helper={snapshot.guidance.fallback}
        />
      </div>

      <div style={cardStyle}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div style={sectionLabel}>Readiness Matrix</div>
            <div className="mt-2 text-[12px]" style={{ color: COLORS.textSecondary }}>
              Proof kinds ADE can normalize today, and which backend can currently satisfy each one.
            </div>
          </div>
          <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })} onClick={() => void window.ade.app.openExternal("https://github.com/ghostwright/ghost-os")}>
            View Backend Setup
          </button>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: MONO_FONT, fontSize: 10 }}>
            <thead>
              <tr style={{ color: COLORS.textMuted, textTransform: "uppercase", letterSpacing: "1px" }}>
                <th style={{ textAlign: "left", padding: "0 0 8px" }}>Proof Kind</th>
                <th style={{ textAlign: "left", padding: "0 0 8px" }}>External Coverage</th>
                <th style={{ textAlign: "left", padding: "0 0 8px" }}>Fallback</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.capabilityMatrix.map((row) => (
                <tr key={row.kind} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                  <td style={{ padding: "10px 0", color: COLORS.textPrimary }}>{formatComputerUseKind(row.kind)}</td>
                  <td style={{ padding: "10px 0", color: COLORS.textSecondary }}>
                    {row.externalBackends.length > 0 ? row.externalBackends.join(", ") : "No approved external backend detected"}
                  </td>
                  <td style={{ padding: "10px 0", color: row.localFallbackAvailable ? COLORS.info : COLORS.textDim }}>
                    {row.localFallbackAvailable ? "Fallback available" : "No local fallback"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {error ? (
        <div style={{ color: COLORS.warning, fontFamily: MONO_FONT, fontSize: 10 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
