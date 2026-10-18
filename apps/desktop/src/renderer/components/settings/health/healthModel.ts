import type { ProjectHealthIssue, ProjectHealthReport } from "../../../../shared/types/projectHealth";

/**
 * Settings → Health's inner tabs, in rail order. `storage` stays the Settings
 * tab id so every old link keeps landing here.
 */
export const HEALTH_TABS = [
  { id: "overview", label: "Overview" },
  { id: "space", label: "Space" },
  { id: "cleanups", label: "Cleanups" },
  { id: "sessions", label: "Sessions" },
  { id: "service", label: "Service" },
] as const;

export type HealthTabId = (typeof HEALTH_TABS)[number]["id"];

export function isHealthTabId(value: string | null | undefined): value is HealthTabId {
  return HEALTH_TABS.some((tab) => tab.id === value);
}

/**
 * Which inner tab owns a settings anchor. Old `#storage`, `#diagnostics`,
 * `#lane-storage-rules` and `#session-lifecycle` links open the tab that now
 * holds that card.
 */
const ANCHOR_TABS: Readonly<Record<string, HealthTabId>> = {
  "project-health": "overview",
  storage: "space",
  "storage-cleanups": "cleanups",
  "lane-storage-rules": "cleanups",
  "session-lifecycle": "sessions",
  project: "sessions",
  diagnostics: "service",
};

export function healthTabForAnchor(anchor: string | null | undefined): HealthTabId | null {
  if (!anchor) return null;
  return ANCHOR_TABS[anchor] ?? null;
}

/** Problems and warnings need attention; info lines are notes. */
export function issuesNeedingAttention(report: ProjectHealthReport | null): ProjectHealthIssue[] {
  return (report?.issues ?? []).filter((issue) => issue.severity !== "info");
}

/** The one line at the top of the page. */
export function healthVerdict(report: ProjectHealthReport | null): { title: string; tone: "ok" | "warn" | "crit" } {
  const attention = issuesNeedingAttention(report);
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
export function healthAgentPrompt(report: ProjectHealthReport): string {
  const issues = report.issues.map((issue, index) => {
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
    report.issues.length === 1
      ? `ADE's health check found one issue in the project at \`${report.projectRoot}\`. Go through it with me: explain what it means and what happens if it is left, check it yourself, and offer a fix. Ask me before you change anything.`
      : `ADE's health check found ${report.issues.length} issues in the project at \`${report.projectRoot}\`. Go through them with me: for each, explain what it means and what happens if it is left, check it yourself, and offer a fix. Ask me before you change anything.`,
    "",
    "## Issues",
    ...issues,
    "",
    "Rules:",
    "- Where ADE has its own fix, say so: I can press it in Settings → Health. Offer to do the same by hand only if I ask.",
    "- Don't delete files, branches or lanes, and don't run installs, without my OK.",
    "- Keep the report short: what you checked, what you fixed (only with my OK), what I need to do.",
  ].join("\n");
}
