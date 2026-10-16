import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CaretDown, WarningCircle } from "@phosphor-icons/react";
import type { AdeCleanupResult, AdeHealthIssue, AdeProjectSnapshot } from "../../../shared/types";
import { ModernSection } from "./primitives";
import "./machineSettings.css";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { Banner } from "../ui/notice";

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
  const startupFixes = snapshot.cleanup.changed ? 1 : 0;
  return missingPaths + healthIssues + startupFixes;
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
    <div className="ade-pj-disclosure">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="ade-pj-disclosure-btn">
        <CaretDown size={12} weight="bold" className="ade-pj-caret" data-open={expanded || undefined} />
        <span className="ade-pj-disclosure-title">{title}</span>
        <span className="ade-pj-disclosure-sub">{subtitle}</span>
      </button>
      {expanded ? <div className="ade-pj-disclosure-body">{children}</div> : null}
    </div>
  );
}

function IssueCard({ issue }: { issue: AdeHealthIssue }) {
  const tone = issue.severity === "error" ? "crit" : issue.severity === "warning" ? "warn" : undefined;
  return (
    <div className="ade-modern-note" data-tone={tone}>
      <WarningCircle size={14} weight="fill" />
      <div className="ade-modern-note-body">
        <span>{issue.message}</span>
        {issue.relativePath ? <span className="ade-modern-path">{issue.relativePath}</span> : null}
      </div>
    </div>
  );
}

export function ProjectSection() {
  // This machine's checkout of the repo, read on the machine the Settings page
  // is showing. A null pin is the tab's binding.
  const { pin } = useSettingsMachineScope();
  const [snapshot, setSnapshot] = useState<AdeProjectSnapshot | null>(null);
  const [busy, setBusy] = useState<"repair" | "integrity" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const refresh = useCallback(async () => {
    const next = await window.ade.project.getSnapshot(pin);
    setSnapshot(next);
    return next;
  }, [pin]);

  useEffect(() => {
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    // The change feed describes the tab's own project. Another machine has no
    // feed here, so its card refreshes after each action instead.
    if (pin) return undefined;
    const unsubscribe = window.ade.project.onStateEvent((event) => {
      setSnapshot(event.snapshot);
      setNotice("Project config reloaded.");
      setError(null);
    });
    return unsubscribe;
  }, [pin, refresh]);

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

  const hint = (
    <>
      Team settings and local runtime data live in a <code className="ade-modern-code">.ade/</code> folder inside this repo.
    </>
  );

  if (!snapshot) {
    return (
      <ModernSection group="Project files" anchor="project" title="Project files" hint={hint}>
        <p className="ade-modern-muted">Loading project files...</p>
        {error ? (
          <Banner layout="inline" model={{ id: "project-section-error", tone: "error", title: error }} />
        ) : null}
      </ModernSection>
    );
  }

  const warnings = snapshot.health.filter((issue) => issue.severity !== "info");
  const folderLabel = grouped.missing.length > 0
    ? `${grouped.missing.length} missing path${grouped.missing.length === 1 ? "" : "s"}`
    : snapshot.cleanup.changed
      ? `${snapshot.cleanup.actions.length} auto-fix${snapshot.cleanup.actions.length === 1 ? "" : "es"} at startup`
      : "Looks good";
  const folderWarn = grouped.missing.length > 0 || snapshot.cleanup.changed;

  return (
    <ModernSection
      group="Project files"
      anchor="project"
      title="Project files"
      hint={hint}
      actions={(
        <>
          <button
            type="button"
            className="ade-modern-btn"
            data-variant="ghost"
            disabled={busy != null}
            onClick={() => void runAction("integrity", () => window.ade.project.runIntegrityCheck(pin))}
          >
            {busy === "integrity" ? "Repairing..." : "Repair session logs"}
          </button>
          <button
            type="button"
            className="ade-modern-btn"
            data-tone={actionableIssues > 0 ? "primary" : undefined}
            disabled={busy != null}
            onClick={() => void runAction("repair", () => window.ade.project.initializeOrRepair(pin))}
          >
            {busy === "repair" ? "Repairing..." : "Fix .ade folder"}
          </button>
        </>
      )}
    >
      <div className="ade-modern-stats">
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">Health</span>
          <span className="ade-modern-stat-value">
            <span className="kit-dot" data-state={healthy ? "ok" : "warn"} aria-hidden />
            <span className="kit-stat">{healthy ? "Healthy" : "Needs attention"}</span>
          </span>
          <span className="ade-modern-stat-sub">
            {healthy
              ? "Folder, config files and warnings are all in good shape."
              : "Review the items below or use a repair action."}
          </span>
        </div>
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">Missing paths</span>
          <span className="ade-modern-stat-value">
            <span className="kit-stat kit-num" style={grouped.missing.length > 0 ? { color: "var(--kit-warn)" } : undefined}>{grouped.missing.length}</span>
            {folderWarn ? <span className="kit-tag" data-tone="warn">{folderLabel}</span> : null}
          </span>
          <span className="ade-modern-stat-sub">
            {grouped.tracked.length} in git · {grouped.ignored.length} local only
          </span>
        </div>
        <div className="ade-modern-stat">
          <span className="kit-eyebrow">Warnings</span>
          <span className="ade-modern-stat-value">
            <span className="kit-stat kit-num" style={warnings.length > 0 ? { color: "var(--kit-warn)" } : undefined}>{warnings.length}</span>
          </span>
          <span className="ade-modern-stat-sub">
            Your overrides: <span className="kit-num">{relativeAdePath(snapshot.config.localPath, snapshot.adeDir)}</span>
          </span>
        </div>
      </div>

      {warnings.length > 0 ? (
        <div className="ade-modern-stack" style={{ gap: 8 }}>
          {warnings.map((issue, index) => (
            <IssueCard key={`${issue.code}:${index}`} issue={issue} />
          ))}
        </div>
      ) : null}

      {notice ? (
        <Banner layout="inline" model={{ id: "project-section-notice", tone: "success", title: notice }} />
      ) : null}
      {error ? (
        <Banner layout="inline" model={{ id: "project-section-error", tone: "error", title: error }} />
      ) : null}

      <div className="ade-modern-rows">
        <CollapsiblePanel
          title="Folder details"
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
            <div className="ade-pj-entries">
              {snapshot.entries.map((entry) => (
                <div key={entry.relativePath} className="ade-pj-entry">
                  <span className="ade-modern-path" style={{ color: "var(--color-fg)" }}>.ade/{entry.relativePath}</span>
                  <span style={{ display: "flex", gap: 6, flex: "none" }}>
                    <span className="kit-tag">{entry.kind === "tracked" ? "in git" : "local only"}</span>
                    <span className="kit-tag" data-tone={entry.exists ? "ok" : "warn"}>{entry.exists ? "present" : "missing"}</span>
                  </span>
                </div>
              ))}
            </div>
            {snapshot.cleanup.actions.length > 0 ? (
              <div className="ade-modern-path" style={{ marginTop: 10, display: "grid", gap: 4 }}>
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
            <dl className="ade-modern-facts">
              <dt>Team defaults</dt>
              <dd className="ade-modern-path">{snapshot.config.sharedPath}</dd>
              <dt>Your overrides</dt>
              <dd className="ade-modern-path">{snapshot.config.localPath}</dd>
              <dt>Secrets</dt>
              <dd className="ade-modern-path">{snapshot.config.secretPath}</dd>
            </dl>
          </CollapsiblePanel>
        </CollapsiblePanel>
      </div>
    </ModernSection>
  );
}
