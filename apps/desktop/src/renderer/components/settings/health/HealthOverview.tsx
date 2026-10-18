import React from "react";
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Robot,
} from "@phosphor-icons/react";
import type { ProjectHealthIssue } from "../../../../shared/types/projectHealth";
import { ModernSection } from "../primitives";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { confirmDialog } from "../../ui/dialog";
import { Banner } from "../../ui/notice";
import { READABLE_TOAST_DURATION_MS, showToast } from "../../app/toast/toastStore";
import { relativeWhen } from "../../../lib/format";
import { AgentLaunchSetup } from "../../shared/AgentLaunchSetup";
import { appResourcePressureLevel } from "../../../lib/resourcePressure";
import {
  formatBytes,
  formatMeasuredBytes,
  freeSpaceLevel,
  responseHealth,
  serviceMemory,
} from "../storage/storageView";
import { FreeSpaceMeter } from "./healthCharts";
import {
  healthAgentPrompt,
  healthVerdict,
  issueDotState,
  issuesNeedingAttention,
  type HealthTabId,
} from "./healthModel";
import type { HealthData } from "./useHealthData";

const FIX_TOAST_ID = "settings-health-fix";

function IssueCard({
  issue,
  fixing,
  onFix,
}: {
  issue: ProjectHealthIssue;
  fixing: boolean;
  onFix: (issue: ProjectHealthIssue) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const items = issue.items ?? [];
  return (
    <li className="ade-health-issue" data-severity={issue.severity}>
      <span className="kit-dot" data-state={issueDotState(issue.severity)} aria-hidden />
      <div className="ade-health-issue-body">
        <div className="ade-health-issue-title">{issue.title}</div>
        <div className="ade-health-issue-detail" title={issue.detail}>{issue.detail}</div>
        {items.length > 0 ? (
          <>
            <button
              type="button"
              className="ade-health-disclosure"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <CaretDown size={11} weight="bold" className="ade-health-caret" data-open={open || undefined} />
              {open ? "Hide" : "Show"} {items.length === 1 ? "1 item" : `${items.length} items`}
            </button>
            {open ? (
              <ul className="ade-health-issue-items">
                {items.map((item) => <li key={item} className="ade-modern-path">{item}</li>)}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
      {issue.fix ? (
        <button
          type="button"
          className="ade-modern-btn"
          data-size="sm"
          disabled={fixing}
          title={issue.fix.description}
          onClick={() => onFix(issue)}
        >
          {fixing ? <CircleNotch size={12} className="animate-spin" /> : null}
          {issue.fix.label}
        </button>
      ) : null}
    </li>
  );
}

export function HealthOverview({ data, onOpenTab }: { data: HealthData; onOpenTab: (tab: HealthTabId) => void }) {
  const { pin, isThisMachine } = useSettingsMachineScope();
  const { report, loading, checking, error, available } = data.report;
  const [fixingId, setFixingId] = React.useState<string | null>(null);
  const [askOpen, setAskOpen] = React.useState(false);
  const verdict = healthVerdict(report);
  const attention = issuesNeedingAttention(report);
  const notes = (report?.issues ?? []).filter((issue) => issue.severity === "info");
  const passed = (report?.checks ?? []).filter((check) => check.ok);

  const runFix = async (issue: ProjectHealthIssue) => {
    const fix = issue.fix;
    if (!fix || fixingId) return;
    if (fix.kind === "change") {
      const confirmed = await confirmDialog({
        title: `${fix.label}?`,
        message: fix.description,
        confirmLabel: fix.label,
      });
      if (!confirmed) return;
    }
    setFixingId(fix.id);
    try {
      // The fix runs on the machine that owns the project, like the report.
      const result = await window.ade.projectHealth.fix({ fixId: fix.id }, pin);
      data.setReport(result.report);
      const lines = [...result.done, ...result.problems];
      showToast({
        id: FIX_TOAST_ID,
        tone: result.ok && result.problems.length === 0 ? "success" : "warning",
        title: result.ok && result.problems.length === 0 ? `${fix.label}: done` : `${fix.label}: not everything worked`,
        message: lines.length > 0 ? lines.join("\n") : undefined,
        durationMs: lines.length > 1 ? READABLE_TOAST_DURATION_MS : undefined,
      });
    } catch (err) {
      showToast({
        id: FIX_TOAST_ID,
        tone: "error",
        title: `Couldn't run ${fix.label.toLowerCase()}`,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setFixingId(null);
    }
  };

  const snapshot = data.storage.snapshot;
  const database = snapshot?.categories.find((category) => category.id === "database") ?? null;
  const freeBytes = report?.drive?.freeBytes ?? snapshot?.volume.freeBytes ?? null;
  const totalBytes = report?.drive?.totalBytes ?? snapshot?.volume.totalBytes ?? null;
  const level = freeBytes != null && totalBytes != null ? freeSpaceLevel(freeBytes, totalBytes) : undefined;
  const service = serviceMemory(data.diagnostics.usage);
  const responses = responseHealth(data.diagnostics.runtimeHealth);
  const load = data.diagnostics.usage ? appResourcePressureLevel(data.diagnostics.usage) : null;

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group="Project health"
        anchor="project-health"
        title={loading && !report ? "Checking this project…" : report ? verdict.title : "Project health"}
        hint={report
          ? `${report.drive ? `On ${report.drive.name}. ` : ""}Checked ${relativeWhen(report.checkedAt)}.`
          : available
            ? "What is wrong with this project, and a fix for what ADE can fix."
            : "Project health needs a newer ADE on this machine."}
        actions={available ? (
          <>
            <button
              type="button"
              className="ade-modern-btn"
              data-variant="ghost"
              disabled={checking || loading}
              onClick={() => void data.loadReport({ force: true })}
            >
              <ArrowClockwise size={13} className={checking ? "animate-spin" : undefined} />
              {checking ? "Checking" : "Check again"}
            </button>
            {report && report.issues.length > 0 && !askOpen ? (
              <button type="button" className="ade-modern-btn" data-tone="primary" onClick={() => setAskOpen(true)}>
                <Robot size={13} />
                Ask an agent to fix these
              </button>
            ) : null}
          </>
        ) : undefined}
      >
        {error && !report ? (
          <Banner
            layout="inline"
            model={{
              id: "health-report-error",
              tone: "error",
              title: "ADE couldn't check this project",
              detail: error,
              actions: [{ label: "Try again", onClick: () => void data.loadReport({ force: true }) }],
            }}
          />
        ) : null}

        {report && askOpen ? (
          <section className="kit-card">
            <header className="kit-card-head">
              <Robot size={14} />
              Ask an agent
              <span className="ade-health-card-hint">In the main lane. It explains and asks before changing anything.</span>
            </header>
            <div className="kit-card-body">
              <AgentLaunchSetup
                defaultPrompt={healthAgentPrompt(report)}
                chatTitle="Fix project health issues"
                promptLabel="Prompt for the agent"
                pin={pin}
                projectRoot={pin ? null : report.projectRoot}
                onLaunched={() => setAskOpen(false)}
                onCancel={() => setAskOpen(false)}
                failureTitle="Couldn't start the agent"
              />
            </div>
          </section>
        ) : null}

        {report && (attention.length > 0 || notes.length > 0) ? (
          <ul className="ade-health-issues">
            {[...attention, ...notes].map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                fixing={fixingId != null && fixingId === issue.fix?.id}
                onFix={(target) => void runFix(target)}
              />
            ))}
          </ul>
        ) : report ? (
          <div className="ade-modern-note" data-tone="ok">
            <CheckCircle size={14} weight="fill" />
            <span>No problems found in this project.</span>
          </div>
        ) : null}

        {report && passed.length > 0 ? (
          <details className="ade-health-passed">
            <summary>
              <CaretDown size={11} weight="bold" className="ade-health-caret" />
              {passed.length === 1 ? "1 check passed" : `${passed.length} checks passed`}
            </summary>
            <ul>
              {passed.map((check) => (
                <li key={check.id}>
                  <CheckCircle size={12} weight="fill" />
                  {check.label}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </ModernSection>

      <ModernSection group="Project health" title="This machine" hint="Space and the background service, at a glance.">
        <div className="ade-modern-stats">
          <button type="button" className="ade-modern-stat ade-health-tile" onClick={() => onOpenTab("space")}>
            <span className="kit-eyebrow">Free on disk</span>
            <span className="ade-modern-stat-value">
              <span
                className="kit-stat kit-num"
                style={level ? { color: level === "crit" ? "var(--kit-crit)" : "var(--kit-warn)" } : undefined}
              >
                {freeBytes != null ? formatBytes(freeBytes) : "—"}
              </span>
            </span>
            {freeBytes != null && totalBytes != null && totalBytes > 0 ? (
              <>
                <FreeSpaceMeter freeBytes={freeBytes} totalBytes={totalBytes} level={level} />
                <span className="ade-modern-stat-sub">
                  {Math.round((freeBytes / totalBytes) * 100)}% of {formatBytes(totalBytes)} free
                </span>
              </>
            ) : null}
          </button>
          <button type="button" className="ade-modern-stat ade-health-tile" onClick={() => onOpenTab("space")}>
            <span className="kit-eyebrow">ADE data</span>
            <span className="ade-modern-stat-value">
              <span className="kit-stat kit-num">
                {snapshot ? formatMeasuredBytes(snapshot.totalAdeBytes, snapshot.truncated) : "—"}
              </span>
            </span>
            <span className="ade-modern-stat-sub">Lanes, chats, proof, caches and the database</span>
          </button>
          <button type="button" className="ade-modern-stat ade-health-tile" onClick={() => onOpenTab("space")}>
            <span className="kit-eyebrow">Database</span>
            <span className="ade-modern-stat-value">
              <span className="kit-stat kit-num">{database ? formatMeasuredBytes(database.bytes, database.partial) : "—"}</span>
            </span>
            <span className="ade-modern-stat-sub">Including its write-ahead log</span>
          </button>
          <button type="button" className="ade-modern-stat ade-health-tile" onClick={() => onOpenTab("service")}>
            <span className="kit-eyebrow">Background service</span>
            {isThisMachine ? (
              <>
                <span className="ade-modern-stat-value">
                  <span className="kit-dot" data-state={responses && (responses.failed ?? 0) > 0 ? "warn" : "ok"} aria-hidden />
                  <span className="kit-stat" style={{ fontSize: 17 }}>
                    {responses == null
                      ? data.diagnostics.usageReady ? "Running" : "—"
                      : (responses.failed ?? 0) > 0 ? `${responses.failed} failed` : "Responding"}
                  </span>
                </span>
                <span className="ade-modern-stat-sub">
                  {[
                    service ? `${formatBytes(service.bytes)} memory` : null,
                    load != null && load >= 2 ? "computer busy" : null,
                  ].filter(Boolean).join(" · ") || "Last 24 hours"}
                </span>
              </>
            ) : (
              <span className="ade-modern-stat-sub">Only on this computer</span>
            )}
          </button>
        </div>
      </ModernSection>
    </div>
  );
}
