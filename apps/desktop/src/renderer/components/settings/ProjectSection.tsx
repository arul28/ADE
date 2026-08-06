import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CaretDown, CheckCircle, FolderOpen, WarningCircle } from "@phosphor-icons/react";
import type { AdeCleanupResult, AdeHealthIssue, AdeProjectSnapshot } from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
  inlineBadge,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";
import { SettingsSectionShell } from "./settingsSectionUi";

const summaryRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "120px minmax(0, 1fr)",
  gap: 12,
  alignItems: "baseline",
  padding: "6px 0",
};

const summaryLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
};

const summaryValueStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  lineHeight: 1.5,
};

const detailRowStyle: React.CSSProperties = {
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

function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function relativeAdePath(absolutePath: string, adeDir: string): string {
  if (absolutePath.startsWith(adeDir)) {
    const suffix = absolutePath.slice(adeDir.length).replace(/^[/\\]/, "");
    return suffix ? `.ade/${suffix}` : ".ade";
  }
  return basename(absolutePath);
}

function formatCleanupNotice(result: AdeCleanupResult, verb: string): string {
  if (!result.changed) return `${verb}: no changes needed.`;
  return `${verb}: ${result.actions.length} change${result.actions.length === 1 ? "" : "s"} applied.`;
}

function countActionableIssues(snapshot: AdeProjectSnapshot): number {
  const missingPaths = snapshot.entries.filter((entry) => !entry.exists).length;
  const healthIssues = snapshot.health.filter((issue) => issue.severity !== "info").length;
  const trustIssue = snapshot.config.trust.requiresSharedTrust ? 1 : 0;
  const startupFixes = snapshot.cleanup.changed ? 1 : 0;
  return missingPaths + healthIssues + trustIssue + startupFixes;
}

function CollapsiblePanel({
  title,
  subtitle,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 12, marginTop: 12 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: 0,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <CaretDown
          size={14}
          weight="bold"
          style={{
            color: COLORS.textDim,
            flexShrink: 0,
            transition: "transform 150ms ease",
            transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{title}</span>
        <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>{subtitle}</span>
      </button>
      {expanded ? <div style={{ marginTop: 12 }}>{children}</div> : null}
    </div>
  );
}

function IssueCard({ issue }: { issue: AdeHealthIssue }) {
  const color =
    issue.severity === "error"
      ? COLORS.danger
      : issue.severity === "warning"
        ? COLORS.warning
        : COLORS.accent;
  return (
    <div style={{ border: `1px solid ${COLORS.border}`, padding: 10, background: COLORS.recessedBg }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span
          style={badgeStyle(
            color,
            issue.severity === "error"
              ? "color-mix(in srgb, var(--color-error) 15%, transparent)"
              : issue.severity === "warning"
                ? "color-mix(in srgb, var(--color-warning) 15%, transparent)"
                : COLORS.accentSubtle,
          )}
        >
          {issue.severity}
        </span>
      </div>
      <div style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.5 }}>{issue.message}</div>
      {issue.relativePath ? (
        <div style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10, marginTop: 4 }}>{issue.relativePath}</div>
      ) : null}
    </div>
  );
}

export function ProjectSection() {
  const [snapshot, setSnapshot] = useState<AdeProjectSnapshot | null>(null);
  const [busy, setBusy] = useState<"repair" | "integrity" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

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
      setNotice("Project config reloaded.");
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
      setNotice(formatCleanupNotice(result, kind === "repair" ? "Folder repair" : "Session log repair"));
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
      missing: entries.filter((entry) => !entry.exists),
    };
  }, [snapshot]);

  const actionableIssues = snapshot ? countActionableIssues(snapshot) : 0;
  const healthy = snapshot ? actionableIssues === 0 : false;

  if (!snapshot) {
    return (
      <SettingsSectionShell
        title="Project files"
        description={
          <>
            ADE stores team settings and local runtime data in a <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>.ade/</span> folder inside this repo.
          </>
        }
        icon={FolderOpen}
        brandColor="#34D399"
        iconWeight="fill"
      >
        <div style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, padding: "8px 0" }}>
          Loading project files...
        </div>
      </SettingsSectionShell>
    );
  }

  const warnings = snapshot.health.filter((issue) => issue.severity !== "info");
  const teamConfigLabel = snapshot.config.trust.requiresSharedTrust
    ? "Needs approval"
    : "Approved";
  const teamConfigColor = snapshot.config.trust.requiresSharedTrust ? COLORS.warning : COLORS.success;
  const folderLabel = grouped.missing.length > 0
    ? `${grouped.missing.length} missing path${grouped.missing.length === 1 ? "" : "s"}`
    : snapshot.cleanup.changed
      ? `${snapshot.cleanup.actions.length} auto-fix${snapshot.cleanup.actions.length === 1 ? "" : "es"} at startup`
      : "Looks good";
  const folderColor = grouped.missing.length > 0 || snapshot.cleanup.changed ? COLORS.warning : COLORS.success;
  const warningsLabel = warnings.length > 0 ? `${warnings.length} issue${warnings.length === 1 ? "" : "s"}` : "None";

  return (
    <SettingsSectionShell
      title="Project files"
      description={
        <>
          ADE stores team settings and local runtime data in a <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>.ade/</span> folder inside this repo.
        </>
      }
      icon={FolderOpen}
      brandColor="#34D399"
      iconWeight="fill"
    >
      <div style={cardStyle({ padding: 16 })}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
              {healthy ? "Everything looks good" : "Needs attention"}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.6 }}>
              {healthy
                ? "Your repo folder, config files, and warnings are all in good shape."
                : "Review the items below or use a repair action if something looks off."}
            </div>
          </div>
          <span style={inlineBadge(healthy ? COLORS.success : COLORS.warning)}>
            {healthy ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <CheckCircle size={13} weight="fill" />
                OK
              </span>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <WarningCircle size={13} weight="fill" />
                Check
              </span>
            )}
          </span>
        </div>

        <div>
          <div style={summaryRowStyle}>
            <div style={summaryLabelStyle}>Team config</div>
            <div style={summaryValueStyle}>
              <span style={{ color: teamConfigColor, fontWeight: 600 }}>{teamConfigLabel}</span>
              <span style={{ color: COLORS.textMuted }}> · {relativeAdePath(snapshot.config.sharedPath, snapshot.adeDir)}</span>
            </div>
          </div>
          <div style={summaryRowStyle}>
            <div style={summaryLabelStyle}>Your overrides</div>
            <div style={summaryValueStyle}>{relativeAdePath(snapshot.config.localPath, snapshot.adeDir)}</div>
          </div>
          <div style={summaryRowStyle}>
            <div style={summaryLabelStyle}>Folder layout</div>
            <div style={{ ...summaryValueStyle, color: folderColor, fontWeight: 600 }}>{folderLabel}</div>
          </div>
          <div style={summaryRowStyle}>
            <div style={summaryLabelStyle}>Warnings</div>
            <div style={{ ...summaryValueStyle, color: warnings.length > 0 ? COLORS.warning : COLORS.success, fontWeight: 600 }}>
              {warningsLabel}
            </div>
          </div>
        </div>

        {warnings.length > 0 ? (
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            {warnings.map((issue, index) => (
              <IssueCard key={`${issue.code}:${index}`} issue={issue} />
            ))}
          </div>
        ) : null}

        {notice ? (
          <div style={{ marginTop: 14, padding: "8px 10px", border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)", background: "color-mix(in srgb, var(--color-success) 15%, transparent)", color: COLORS.success, fontSize: 12, fontFamily: SANS_FONT }}>
            {notice}
          </div>
        ) : null}
        {error ? (
          <div style={{ marginTop: 14, padding: "8px 10px", border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)", background: "color-mix(in srgb, var(--color-error) 15%, transparent)", color: COLORS.danger, fontSize: 12, fontFamily: SANS_FONT }}>
            {error}
          </div>
        ) : null}

        <CollapsiblePanel
          title="Show folder details"
          subtitle={`${grouped.tracked.length} in git · ${grouped.ignored.length} local only`}
          expanded={detailsOpen}
          onToggle={() => setDetailsOpen((open) => !open)}
        >
          <CollapsiblePanel
            title="Folder layout"
            subtitle="What ADE expects under .ade/"
            expanded={folderOpen}
            onToggle={() => setFolderOpen((open) => !open)}
          >
            {snapshot.entries.map((entry) => (
              <div key={entry.relativePath} style={detailRowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 11 }}>.ade/{entry.relativePath}</div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <span style={badgeStyle(entry.kind === "tracked" ? COLORS.accent : COLORS.textMuted, entry.kind === "tracked" ? COLORS.accentSubtle : COLORS.recessedBg)}>
                    {entry.kind === "tracked" ? "in git" : "local only"}
                  </span>
                  <span style={badgeStyle(entry.exists ? COLORS.success : COLORS.warning, entry.exists ? "color-mix(in srgb, var(--color-success) 15%, transparent)" : "color-mix(in srgb, var(--color-warning) 15%, transparent)")}>
                    {entry.exists ? "present" : "missing"}
                  </span>
                </div>
              </div>
            ))}
            {snapshot.cleanup.actions.length > 0 ? (
              <div style={{ marginTop: 10, color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10, display: "grid", gap: 4 }}>
                {snapshot.cleanup.actions.slice(0, 8).map((action, index) => (
                  <div key={`${action.relativePath}:${index}`}>
                    {action.kind} {action.relativePath}{action.detail ? ` - ${action.detail}` : ""}
                  </div>
                ))}
              </div>
            ) : null}
          </CollapsiblePanel>

          <CollapsiblePanel
            title="Config files"
            subtitle="Team defaults, overrides, and secrets"
            expanded={configOpen}
            onToggle={() => setConfigOpen((open) => !open)}
          >
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Team defaults</div>
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, marginTop: 4 }}>{snapshot.config.sharedPath}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Your overrides</div>
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, marginTop: 4 }}>{snapshot.config.localPath}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Secrets</div>
                <div style={{ fontSize: 11, fontFamily: MONO_FONT, color: COLORS.textPrimary, marginTop: 4 }}>{snapshot.config.secretPath}</div>
              </div>
            </div>
          </CollapsiblePanel>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            <button
              type="button"
              style={actionableIssues > 0 ? primaryButton() : outlineButton()}
              disabled={busy != null}
              onClick={() => void runAction("repair", () => window.ade.project.initializeOrRepair())}
            >
              {busy === "repair" ? "Repairing..." : "Fix .ade folder"}
            </button>
            <button
              type="button"
              style={outlineButton()}
              disabled={busy != null}
              onClick={() => void runAction("integrity", () => window.ade.project.runIntegrityCheck())}
            >
              {busy === "integrity" ? "Repairing..." : "Repair session logs"}
            </button>
          </div>
        </CollapsiblePanel>
      </div>
    </SettingsSectionShell>
  );
}
