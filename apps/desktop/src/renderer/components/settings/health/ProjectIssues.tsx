import React from "react";
import { CaretDown, CircleNotch } from "@phosphor-icons/react";
import type { ProjectHealthIssue, ProjectHealthReport } from "../../../../shared/types/projectHealth";
import type { OpenProjectBinding } from "../../../../shared/types";
import { confirmDialog } from "../../ui/dialog";
import { READABLE_TOAST_DURATION_MS, showToast } from "../../app/toast/toastStore";
import { issueDotState } from "./healthModel";
import { IgnoreButton, IgnoredList, type IgnoreChoice, type ProjectIssueIgnore } from "./ProjectIgnore";
import { plainErrorText } from "../../../lib/plainError";

const FIX_TOAST_ID = "settings-project-fix";

/**
 * Runs one of a project check's own fixes on the machine that owns the
 * project (`pin`, null for the tab's own machine), after confirming what it
 * changes, and hands back the report the fix returns.
 */
export function useProjectFix(pin: OpenProjectBinding | null, onReport: (report: ProjectHealthReport) => void) {
  const [fixingId, setFixingId] = React.useState<string | null>(null);
  const runFix = React.useCallback(async (issue: ProjectHealthIssue) => {
    const fix = issue.fix;
    // No copy online: there is nothing to fix on.
    if (!fix || fixingId || !pin) return;
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
      const result = await window.ade.projectHealth.fix({ fixId: fix.id }, pin);
      onReport(result.report);
      const lines = [...result.done, ...result.problems];
      const clean = result.ok && result.problems.length === 0;
      showToast({
        id: FIX_TOAST_ID,
        tone: clean ? "success" : "warning",
        title: clean ? `${fix.label}: done` : `${fix.label}: not everything worked`,
        message: lines.length > 0 ? lines.join("\n") : undefined,
        durationMs: lines.length > 1 ? READABLE_TOAST_DURATION_MS : undefined,
      });
    } catch (err) {
      showToast({
        id: FIX_TOAST_ID,
        tone: "error",
        title: `Couldn't run ${fix.label.toLowerCase()}`,
        message: plainErrorText(err, "ADE couldn't finish that fix."),
      });
    } finally {
      setFixingId(null);
    }
  }, [fixingId, onReport, pin]);
  return { fixingId, runFix };
}

/** One check that failed: a dot, one line, the detail clamped, items behind a disclosure, and its fix. */
export function ProjectIssueRow({
  issue,
  fixing,
  onFix,
  ignoreChoices = [],
  ignoreBusy = false,
}: {
  issue: ProjectHealthIssue;
  fixing: boolean;
  onFix: (issue: ProjectHealthIssue) => void;
  ignoreChoices?: readonly IgnoreChoice[];
  ignoreBusy?: boolean;
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
      {issue.fix || ignoreChoices.length > 0 ? (
        <span className="ade-health-issue-actions">
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
          <IgnoreButton choices={ignoreChoices} subject={issue.title} disabled={ignoreBusy} />
        </span>
      ) : null}
    </li>
  );
}

export function ProjectIssueList({
  issues,
  fixingId,
  onFix,
  ignore,
}: {
  issues: readonly ProjectHealthIssue[];
  fixingId: string | null;
  onFix: (issue: ProjectHealthIssue) => void;
  ignore?: ProjectIssueIgnore;
}) {
  // Every line hidden: the way back stays, open.
  if (issues.length === 0) return ignore?.entries.length ? <IgnoredList entries={ignore.entries} busy={ignore.busy} defaultOpen /> : null;
  // Problems first, then warnings, then notes.
  const order = { problem: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((left, right) => order[left.severity] - order[right.severity]);
  return (
    <>
      <ul className="ade-health-issues">
        {sorted.map((issue) => (
          <ProjectIssueRow
            key={issue.id}
            issue={issue}
            fixing={fixingId != null && fixingId === issue.fix?.id}
            onFix={onFix}
            ignoreChoices={ignore?.choicesFor(issue)}
            ignoreBusy={ignore?.busy}
          />
        ))}
      </ul>
      {ignore ? <IgnoredList entries={ignore.entries} busy={ignore.busy} /> : null}
    </>
  );
}
