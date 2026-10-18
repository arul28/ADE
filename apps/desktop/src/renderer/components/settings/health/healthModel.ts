import type { ProjectHealthIssue, ProjectHealthReport } from "../../../../shared/types/projectHealth";

/**
 * Which settings page shows a project check. Lane problems sit with the lane
 * list on Project → Lanes; everything else a project can have wrong (paths
 * after a move, git links, dependencies, trust, the drive) sits on
 * Project → Location, where the project lives.
 */
export type ProjectIssuePage = "lanes" | "location";

const LANE_ISSUE_IDS: ReadonlySet<string> = new Set(["stale-lanes", "stuck-sessions", "git-leftovers", "lane-folders"]);

export function projectIssuePage(issue: Pick<ProjectHealthIssue, "id">): ProjectIssuePage {
  return LANE_ISSUE_IDS.has(issue.id) ? "lanes" : "location";
}

export function issuesForPage(report: ProjectHealthReport | null, page: ProjectIssuePage): ProjectHealthIssue[] {
  return (report?.issues ?? []).filter((issue) => projectIssuePage(issue) === page);
}

/** Problems and warnings need attention; info lines are notes. */
export function issuesNeedingAttention(report: ProjectHealthReport | null): ProjectHealthIssue[] {
  return (report?.issues ?? []).filter((issue) => issue.severity !== "info");
}

/** The one line at the top of a page of checks. */
export function healthVerdict(issues: readonly ProjectHealthIssue[]): { title: string; tone: "ok" | "warn" | "crit" } {
  const attention = issues.filter((issue) => issue.severity !== "info");
  if (attention.length === 0) return { title: "Everything looks good", tone: "ok" };
  const tone = attention.some((issue) => issue.severity === "problem") ? "crit" : "warn";
  return {
    title: attention.length === 1 ? "1 thing needs attention" : `${attention.length} things need attention`,
    tone,
  };
}

export function issueDotState(severity: ProjectHealthIssue["severity"]): "crit" | "warn" | undefined {
  if (severity === "problem") return "crit";
  if (severity === "warning") return "warn";
  return undefined;
}

const SEVERITY_WORD: Record<ProjectHealthIssue["severity"], string> = {
  problem: "Problem",
  warning: "Warning",
  info: "Note",
};

/**
 * The prompt "Ask an agent to fix these" starts from: every issue with its
 * detail, the things behind it and what ADE's own fix would do, and the rule
 * that the agent explains and asks before it changes anything.
 */
export function healthAgentPrompt(report: ProjectHealthReport, only?: readonly ProjectHealthIssue[]): string {
  const list = only ?? report.issues;
  const issues = list.map((issue, index) => {
    const lines = [`${index + 1}. [${SEVERITY_WORD[issue.severity]}] ${issue.title}`, `   ${issue.detail}`];
    if (issue.items && issue.items.length > 0) {
      const shown = issue.items.slice(0, 20);
      lines.push(...shown.map((item) => `   - ${item}`));
      if (issue.items.length > shown.length) lines.push(`   - and ${issue.items.length - shown.length} more`);
    }
    if (issue.fix) {
      lines.push(issue.fix.kind === "terminal"
        ? `   ADE's fix ("${issue.fix.label}"): ${issue.fix.description} (opens a terminal and runs a command)`
        : `   ADE's fix ("${issue.fix.label}"): ${issue.fix.description}`);
    }
    return lines.join("\n");
  });
  return [
    list.length === 1
      ? `ADE's project check found one issue in the project at \`${report.projectRoot}\`. Go through it with me: explain what it means and what happens if it is left, check it yourself, and offer a fix. Ask me before you change anything.`
      : `ADE's project check found ${list.length} issues in the project at \`${report.projectRoot}\`. Go through them with me: for each, explain what it means and what happens if it is left, check it yourself, and offer a fix. Ask me before you change anything.`,
    "",
    "## Issues",
    ...issues,
    "",
    "Rules:",
    "- Where ADE has its own fix, say so: I can press it in Settings → Project. Offer to do the same by hand only if I ask.",
    "- Don't delete files, branches or lanes, and don't run installs, without my OK.",
    "- Keep the report short: what you checked, what you fixed (only with my OK), what I need to do.",
  ].join("\n");
}
