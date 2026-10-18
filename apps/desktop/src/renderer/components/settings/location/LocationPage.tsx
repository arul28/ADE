import React from "react";
import { ArrowClockwise, CaretDown, CheckCircle, FolderSimple, HardDrive, HardDrives, Robot } from "@phosphor-icons/react";
import { ModernSection } from "../primitives";
import { useSettingsMachineScope } from "../SettingsMachineScope";
import { ProjectLocationSection } from "../ProjectLocationSection";
import { AgentLaunchSetup } from "../../shared/AgentLaunchSetup";
import { Banner } from "../../ui/notice";
import { relativeWhen } from "../../../lib/format";
import { formatBytes, freeSpaceLevel } from "../storage/storageView";
import { FreeSpaceMeter } from "../health/healthCharts";
import { healthAgentPrompt, healthVerdict, issuesForPage } from "../health/healthModel";
import { ProjectIssueList, useProjectFix } from "../health/ProjectIssues";
import { useHealthData } from "../health/useHealthData";
import "../health/health.css";
import "./location.css";

/**
 * Settings → Project → Location: where the project lives (drive, path, free
 * space), Move… and the old copy a move left, then every check about the
 * project itself — paths after a move, git links, dependencies, virtualenvs,
 * agent trust, files naming old paths, the drive — with ADE's fixes.
 *
 * Remote machines: the checks and their fixes go to the machine that owns the
 * project (`pin`). Moving runs in this computer's main process, so
 * `ProjectLocationSection` says so for a project on another computer.
 */
export function LocationPage() {
  const { pin, isThisMachine } = useSettingsMachineScope();
  const data = useHealthData(pin, isThisMachine, { report: true });
  const fix = useProjectFix(pin, data.setReport);
  const [askOpen, setAskOpen] = React.useState(false);
  const { report, loading, checking, error, available } = data.report;
  const issues = issuesForPage(report, "location");
  const verdict = healthVerdict(issues);
  const passed = (report?.checks ?? []).filter((check) => check.ok);
  const drive = report?.drive ?? null;
  const level = drive && drive.totalBytes > 0 ? freeSpaceLevel(drive.freeBytes, drive.totalBytes) : undefined;

  return (
    <div className="ade-modern-sections">
      {report ? (
        <div className="ade-loc-hero" role="group" aria-label="Where this project lives">
          <span className="ade-loc-hero-icon" aria-hidden>
            {drive ? (drive.internal ? <HardDrive size={22} weight="duotone" /> : <HardDrives size={22} weight="duotone" />) : <FolderSimple size={22} weight="duotone" />}
          </span>
          <div className="ade-loc-hero-body">
            <div className="ade-loc-hero-title">
              <span>{drive?.name ?? "This computer"}</span>
              {drive ? <span className="kit-tag">{drive.internal ? "Built-in" : "External"}</span> : null}
            </div>
            <span className="ade-modern-muted">{drive ? (drive.internal ? "This computer's own disk" : "A drive plugged into this computer") : "Where this project's folder is"}</span>
          </div>
          {drive && drive.totalBytes > 0 ? (
            <div className="ade-loc-hero-meter">
              <div className="ade-loc-hero-meter-label">
                <span className="kit-num" style={level ? { color: level === "crit" ? "var(--kit-crit)" : "var(--kit-warn)" } : undefined}>
                  {formatBytes(drive.freeBytes)}
                </span>
                <span className="ade-modern-muted">free of {formatBytes(drive.totalBytes)}</span>
              </div>
              <FreeSpaceMeter freeBytes={drive.freeBytes} totalBytes={drive.totalBytes} level={level} />
            </div>
          ) : null}
        </div>
      ) : null}

      <ProjectLocationSection />

      <ModernSection
        group="Checks"
        anchor="project-health"
        title={loading && !report ? "Checking this project…" : report ? verdict.title : "Project checks"}
        hint={report
          ? `Checked ${relativeWhen(report.checkedAt)}.`
          : available
            ? "What is wrong with this project, and a fix for what ADE can fix."
            : "Project checks need a newer ADE on this machine."}
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
            {report && issues.length > 0 && !askOpen ? (
              <button type="button" className="ade-modern-btn" onClick={() => setAskOpen(true)}>
                <Robot size={13} />
                Ask an agent
              </button>
            ) : null}
          </>
        ) : undefined}
      >
        {error && !report ? (
          <Banner
            layout="inline"
            model={{
              id: "location-report-error",
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
                defaultPrompt={healthAgentPrompt(report, issues)}
                chatTitle="Fix project problems"
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

        {report && issues.length > 0 ? (
          <ProjectIssueList issues={issues} fixingId={fix.fixingId} onFix={(issue) => void fix.runFix(issue)} />
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
    </div>
  );
}
