import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AdeCleanupResult, AdeProjectSnapshot } from "../../../shared/types";
import { COLORS, MONO_FONT, LABEL_STYLE, cardStyle, outlineButton, primaryButton } from "../lanes/laneDesignTokens";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "8px 0",
  borderBottom: `1px solid ${COLORS.border}`,
};

function badgeStyle(color: string, background: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 18,
    padding: "0 6px",
    border: `1px solid ${color}40`,
    background,
    color,
    fontFamily: MONO_FONT,
    fontSize: 9,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  };
}

function formatCleanupNotice(result: AdeCleanupResult, verb: string): string {
  if (!result.changed) return `${verb}: no changes needed.`;
  return `${verb}: ${result.actions.length} change${result.actions.length === 1 ? "" : "s"} applied.`;
}

export function ProjectSection() {
  const [snapshot, setSnapshot] = useState<AdeProjectSnapshot | null>(null);
  const [busy, setBusy] = useState<"repair" | "integrity" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.ade.project.getSnapshot();
    setSnapshot(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    const unsubscribe = window.ade.project.onStateEvent((event) => {
      setSnapshot(event.snapshot);
      setNotice(`Config reloaded from ${event.filePath}.`);
      setError(null);
    });
    return unsubscribe;
  }, [refresh]);

  const runAction = useCallback(async (
    kind: "repair" | "integrity",
    action: () => Promise<AdeCleanupResult>,
  ) => {
    setBusy(kind);
    setError(null);
    try {
      const result = await action();
      await refresh();
      setNotice(formatCleanupNotice(result, kind === "repair" ? "Structure repair" : "Integrity check"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const grouped = useMemo(() => {
    const entries = snapshot?.entries ?? [];
    return {
      tracked: entries.filter((entry) => entry.kind === "tracked"),
      ignored: entries.filter((entry) => entry.kind === "ignored"),
    };
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12, padding: 20 }}>
        Loading project structure...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={sectionLabelStyle}>PROJECT</div>
        <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.6 }}>
          Canonical `.ade` layout, portable config, and runtime health for this repo. Tracked paths stay shareable; ignored paths stay machine-local.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          style={primaryButton()}
          disabled={busy != null}
          onClick={() => void runAction("repair", () => window.ade.project.initializeOrRepair())}
        >
          {busy === "repair" ? "REPAIRING..." : "REPAIR STRUCTURE"}
        </button>
        <button
          type="button"
          style={outlineButton()}
          disabled={busy != null}
          onClick={() => void runAction("integrity", () => window.ade.project.runIntegrityCheck())}
        >
          {busy === "integrity" ? "CHECKING..." : "RUN INTEGRITY CHECK"}
        </button>
      </div>

      {notice && (
        <div style={{ padding: "8px 10px", border: `1px solid ${COLORS.success}30`, background: `${COLORS.success}15`, color: COLORS.success, fontSize: 11 }}>
          {notice}
        </div>
      )}
      {error && (
        <div style={{ padding: "8px 10px", border: `1px solid ${COLORS.danger}30`, background: `${COLORS.danger}15`, color: COLORS.danger, fontSize: 11 }}>
          {error}
        </div>
      )}

      <div style={cardStyle({ padding: 14 })}>
        <div style={sectionLabelStyle}>STRUCTURE</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <span style={badgeStyle(COLORS.accent, COLORS.accentSubtle)}>tracked {grouped.tracked.length}</span>
          <span style={badgeStyle(COLORS.textMuted, COLORS.recessedBg)}>ignored {grouped.ignored.length}</span>
          <span style={badgeStyle(snapshot.cleanup.changed ? COLORS.warning : COLORS.success, snapshot.cleanup.changed ? `${COLORS.warning}15` : `${COLORS.success}15`)}>
            {snapshot.cleanup.changed ? `${snapshot.cleanup.actions.length} startup fixes` : "startup clean"}
          </span>
        </div>
        {snapshot.entries.map((entry) => (
          <div key={entry.relativePath} style={rowStyle}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 11 }}>{entry.relativePath}</div>
              <div style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10 }}>{entry.absolutePath}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <span style={badgeStyle(entry.kind === "tracked" ? COLORS.accent : COLORS.textMuted, entry.kind === "tracked" ? COLORS.accentSubtle : COLORS.recessedBg)}>
                {entry.kind}
              </span>
              <span style={badgeStyle(entry.exists ? COLORS.success : COLORS.warning, entry.exists ? `${COLORS.success}15` : `${COLORS.warning}15`)}>
                {entry.exists ? "present" : "missing"}
              </span>
            </div>
          </div>
        ))}
        {snapshot.cleanup.actions.length > 0 && (
          <div style={{ marginTop: 10, color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10, display: "grid", gap: 4 }}>
            {snapshot.cleanup.actions.slice(0, 8).map((action, index) => (
              <div key={`${action.relativePath}:${index}`}>
                {action.kind} {action.relativePath}{action.detail ? ` — ${action.detail}` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={cardStyle({ padding: 14 })}>
        <div style={sectionLabelStyle}>CONFIGURATION</div>
        <div style={{ display: "grid", gap: 8, fontFamily: MONO_FONT, fontSize: 11 }}>
          <div>
            <div style={{ color: COLORS.textMuted }}>shared</div>
            <div style={{ color: COLORS.textPrimary }}>{snapshot.config.sharedPath}</div>
          </div>
          <div>
            <div style={{ color: COLORS.textMuted }}>local</div>
            <div style={{ color: COLORS.textPrimary }}>{snapshot.config.localPath}</div>
          </div>
          <div>
            <div style={{ color: COLORS.textMuted }}>secret</div>
            <div style={{ color: COLORS.textPrimary }}>{snapshot.config.secretPath}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            <span style={badgeStyle(snapshot.config.trust.requiresSharedTrust ? COLORS.warning : COLORS.success, snapshot.config.trust.requiresSharedTrust ? `${COLORS.warning}15` : `${COLORS.success}15`)}>
              {snapshot.config.trust.requiresSharedTrust ? "shared trust required" : "shared trust current"}
            </span>
            <span style={badgeStyle(COLORS.textMuted, COLORS.recessedBg)}>shared {snapshot.config.trust.sharedHash.slice(0, 8) || "n/a"}</span>
            <span style={badgeStyle(COLORS.textMuted, COLORS.recessedBg)}>local {snapshot.config.trust.localHash.slice(0, 8) || "n/a"}</span>
          </div>
        </div>
      </div>

      <div style={cardStyle({ padding: 14 })}>
        <div style={sectionLabelStyle}>HEALTH</div>
        {snapshot.health.length === 0 ? (
          <div style={{ color: COLORS.success, fontFamily: MONO_FONT, fontSize: 11 }}>No health warnings detected.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {snapshot.health.map((issue, index) => (
              <div key={`${issue.code}:${index}`} style={{ border: `1px solid ${COLORS.border}`, padding: 10, background: COLORS.recessedBg }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span
                    style={badgeStyle(
                      issue.severity === "error" ? COLORS.danger : issue.severity === "warning" ? COLORS.warning : COLORS.accent,
                      issue.severity === "error" ? `${COLORS.danger}15` : issue.severity === "warning" ? `${COLORS.warning}15` : COLORS.accentSubtle,
                    )}
                  >
                    {issue.severity}
                  </span>
                  <span style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 10 }}>{issue.code}</span>
                </div>
                <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 11 }}>{issue.message}</div>
                {issue.relativePath && (
                  <div style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10, marginTop: 4 }}>{issue.relativePath}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
